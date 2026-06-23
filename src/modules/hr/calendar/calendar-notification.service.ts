import { Injectable, NotFoundException } from '@nestjs/common';
import { student_status } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { FcmService } from '../../../common/fcm/fcm.service';
import { CalendarDayResolverService } from './calendar-day-resolver.service';

function formatDatePKT(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Karachi',
  }).format(date);
}

@Injectable()
export class CalendarNotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fcmService: FcmService,
    private readonly calendarResolver: CalendarDayResolverService,
  ) {}

  async notifyStudentDay(
    familyId: number,
    studentCc: number,
    date: Date,
    alertType: string,
    title: string,
    body: string,
  ) {
    const row = await this.prisma.calendar_notifications.upsert({
      where: {
        family_id_student_cc_date_alert_type: {
          family_id: familyId,
          student_cc: studentCc,
          date,
          alert_type: alertType,
        },
      },
      create: {
        family_id: familyId,
        student_cc: studentCc,
        date,
        alert_type: alertType,
        title,
        body,
      },
      update: {},
    });

    await this.fcmService.sendToFamily(familyId, title, body, {
      type: 'calendar_alert',
      student_cc: String(studentCc),
      date: date.toISOString(),
      alert_type: alertType,
    });

    return row;
  }

  private matchesStudentScope(row: any, classId: number | null, sectionId: number | null): boolean {
    if (row.section_id != null) {
      return row.class_id === classId && row.section_id === sectionId;
    }
    if (row.class_id != null) {
      return row.class_id === classId;
    }
    return true;
  }

  async notifyFamiliesForCalendarDay(calendarRow: any) {
    if (calendarRow.applies_to !== 'STUDENT') return;

    const students = await this.prisma.students.findMany({
      where: {
        campus_id: calendarRow.campus_id,
        status: student_status.ENROLLED,
        deleted_at: null,
      },
      select: {
        cc: true,
        full_name: true,
        family_id: true,
        class_id: true,
        section_id: true,
      },
    });

    const formattedDate = formatDatePKT(calendarRow.date);
    const rawDesc = calendarRow.description || 'Holiday';
    const cleanDesc = rawDesc.startsWith('[PINNED] ') ? rawDesc.replace('[PINNED] ', '') : rawDesc;

    for (const student of students) {
      if (!student.family_id) continue;
      if (!this.matchesStudentScope(calendarRow, student.class_id, student.section_id)) continue;

      const body = `${student.full_name} — TAFS is closed on ${formattedDate} for ${cleanDesc}.`;
      await this.notifyStudentDay(
        student.family_id,
        student.cc,
        calendarRow.date,
        'HOLIDAY',
        'School Closed',
        body,
      );
    }
  }

  /** Remove day-off alerts when the calendar no longer marks the date as closed. */
  async clearStaleDayOffAlerts(campusId: number, date: Date) {
    const students = await this.prisma.students.findMany({
      where: {
        campus_id: campusId,
        status: student_status.ENROLLED,
        deleted_at: null,
      },
      select: {
        cc: true,
        family_id: true,
        class_id: true,
        section_id: true,
      },
    });

    for (const student of students) {
      if (!student.family_id) continue;

      const resolved = await this.calendarResolver.resolveStudentDay(
        campusId,
        student.class_id,
        student.section_id,
        date,
      );
      if (!resolved.isWorkingDay) continue;

      await this.prisma.calendar_notifications.deleteMany({
        where: {
          family_id: student.family_id,
          student_cc: student.cc,
          date,
          alert_type: { in: ['HOLIDAY', 'DAY_OFF'] },
        },
      });
    }
  }

  async notifyDayOffForCampusDate(campusId: number, date: Date) {
    const students = await this.prisma.students.findMany({
      where: {
        campus_id: campusId,
        status: student_status.ENROLLED,
        deleted_at: null,
      },
      select: {
        cc: true,
        full_name: true,
        family_id: true,
        class_id: true,
        section_id: true,
      },
    });

    const formattedDate = formatDatePKT(date);

    for (const student of students) {
      if (!student.family_id) continue;

      const resolved = await this.calendarResolver.resolveStudentDay(
        campusId,
        student.class_id,
        student.section_id,
        date,
      );

      if (resolved.isWorkingDay) continue;

      if (resolved.dayType === 'HOLIDAY') {
        const rawResolvedDesc = resolved.description || 'Holiday';
        const cleanResolvedDesc = rawResolvedDesc.startsWith('[PINNED] ') ? rawResolvedDesc.replace('[PINNED] ', '') : rawResolvedDesc;
        const body = `${student.full_name} — TAFS is closed on ${formattedDate} for ${cleanResolvedDesc}.`;
        await this.notifyStudentDay(
          student.family_id,
          student.cc,
          date,
          'HOLIDAY',
          'School Closed',
          body,
        );
      } else if (resolved.dayType === 'WEEKEND') {
        const body = `${student.full_name} — TAFS is closed on ${formattedDate} (weekend).`;
        await this.notifyStudentDay(
          student.family_id,
          student.cc,
          date,
          'DAY_OFF',
          'Scheduled Day Off',
          body,
        );
      }
    }
  }

  async notifySchoolOpenForCalendarDay(calendarRow: any) {
    if (calendarRow.applies_to !== 'STUDENT') return;

    const students = await this.prisma.students.findMany({
      where: {
        campus_id: calendarRow.campus_id,
        status: student_status.ENROLLED,
        deleted_at: null,
      },
      select: {
        cc: true,
        full_name: true,
        family_id: true,
        class_id: true,
        section_id: true,
      },
    });

    const formattedDate = formatDatePKT(calendarRow.date);

    for (const student of students) {
      if (!student.family_id) continue;
      if (!this.matchesStudentScope(calendarRow, student.class_id, student.section_id)) continue;

      const body = `${student.full_name} — TAFS will be open on ${formattedDate}.`;
      await this.notifyStudentDay(
        student.family_id,
        student.cc,
        calendarRow.date,
        'SCHOOL_OPEN',
        'School Open',
        body,
      );
    }
  }

  async getForFamily(familyId: number, cursor?: number) {
    const notifications = await this.prisma.calendar_notifications.findMany({
      where: {
        family_id: familyId,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { created_at: 'desc' },
      include: {
        students: { select: { full_name: true, campus_id: true } },
      },
      take: 20,
    });

    const dates = [...new Set(notifications.map((n) => n.date.toISOString()))].map((d) => new Date(d));
    const calendarDays = await this.prisma.academic_calendar_days.findMany({
      where: {
        date: { in: dates },
        applies_to: 'STUDENT',
      },
      select: { date: true, campus_id: true, description: true },
    });

    const holidayKey = (date: Date, campusId: number) => `${date.toISOString().slice(0, 10)}-${campusId}`;
    const pinnedHolidays = new Set(
      calendarDays
        .filter((c) => c.description?.startsWith('[PINNED] '))
        .map((c) => holidayKey(c.date, c.campus_id)),
    );

    return notifications.map((n) => {
      const isPinned = n.students?.campus_id
        ? pinnedHolidays.has(holidayKey(n.date, n.students.campus_id))
        : false;
      const cleanBody = n.body.includes('[PINNED] ') ? n.body.replace('[PINNED] ', '') : n.body;
      return {
        id: n.id,
        family_id: n.family_id,
        student_cc: n.student_cc,
        date: n.date,
        alert_type: n.alert_type,
        title: n.title,
        body: cleanBody,
        read_at: n.read_at,
        created_at: n.created_at,
        students: n.students,
        is_pinned: isPinned,
      };
    });
  }

  async markRead(id: number, familyId: number) {
    const notification = await this.prisma.calendar_notifications.findFirst({
      where: { id, family_id: familyId },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    return this.prisma.calendar_notifications.update({
      where: { id },
      data: { read_at: new Date() },
    });
  }
}
