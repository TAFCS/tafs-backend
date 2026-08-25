import { Injectable, NotFoundException } from '@nestjs/common';
import { student_status } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { FcmService } from '../../../common/fcm/fcm.service';
import { CalendarDayResolverService } from './calendar-day-resolver.service';
import { resolveTemplate, isTemplateDisabled } from '../../../utils/notification-templates.util';

function formatDatePKT(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Karachi',
  }).format(date);
}

export type CalendarNotificationFailure = {
  student_cc: number;
  family_id?: number;
  student_name?: string | null;
  reason: string;
};

export type CalendarNotificationReport = {
  attempted: number;
  notified: number;
  already_notified: number;
  skipped_no_family: number;
  failed: number;
  failures: CalendarNotificationFailure[];
};

function emptyReport(): CalendarNotificationReport {
  return {
    attempted: 0,
    notified: 0,
    already_notified: 0,
    skipped_no_family: 0,
    failed: 0,
    failures: [],
  };
}

/** One-line summary for API `notification_warning` / UI banners. */
export function formatNotificationReport(report: CalendarNotificationReport | null | undefined): string | null {
  if (!report) return null;
  if (report.attempted === 0 && report.skipped_no_family === 0 && report.failed === 0) {
    return null;
  }
  const delivered = report.notified + report.already_notified;
  const parts: string[] = [];
  if (report.attempted > 0) {
    parts.push(`Notifications: ${delivered} of ${report.attempted} student(s) covered`);
  } else {
    parts.push('Notifications: no eligible students with a family link');
  }
  if (report.already_notified > 0) {
    parts.push(`${report.already_notified} already notified`);
  }
  if (report.skipped_no_family > 0) {
    parts.push(`${report.skipped_no_family} with no family link skipped`);
  }
  if (report.failed > 0) {
    const sample = report.failures
      .slice(0, 3)
      .map((f) => `CC ${f.student_cc}${f.reason ? ` (${f.reason})` : ''}`)
      .join('; ');
    parts.push(`${report.failed} failed${sample ? `: ${sample}` : ''}`);
  }
  return parts.join(' · ');
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
  ): Promise<'created' | 'already_notified'> {
    const existing = await this.prisma.calendar_notifications.findUnique({
      where: {
        family_id_student_cc_date_alert_type: {
          family_id: familyId,
          student_cc: studentCc,
          date,
          alert_type: alertType,
        },
      },
    });

    if (existing) return 'already_notified';

    await this.prisma.calendar_notifications.create({
      data: {
        family_id: familyId,
        student_cc: studentCc,
        date,
        alert_type: alertType,
        title,
        body,
      },
    });

    // FCM failures are swallowed inside sendToFamily — in-app row is the source of truth.
    await this.fcmService.sendToFamily(familyId, title, body, {
      type: 'calendar_alert',
      student_cc: String(studentCc),
      date: date.toISOString(),
      alert_type: alertType,
    });

    return 'created';
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

  private async notifyScopedStudents(
    calendarRow: any,
    alertType: string,
    titleKey: string,
    titleFallback: string,
    bodyKey: string,
    bodyFallback: string,
    buildVars: (student: { full_name: string | null }, formattedDate: string, cleanDesc: string) => Record<string, string>,
  ): Promise<CalendarNotificationReport> {
    const report = emptyReport();
    if (calendarRow.applies_to !== 'STUDENT') return report;
    if (await isTemplateDisabled(this.prisma, titleKey)) return report;

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
      if (!this.matchesStudentScope(calendarRow, student.class_id, student.section_id)) {
        continue;
      }
      if (!student.family_id) {
        report.skipped_no_family++;
        continue;
      }

      report.attempted++;
      try {
        const vars = buildVars(student, formattedDate, cleanDesc);
        const title = await resolveTemplate(this.prisma, titleKey, titleFallback, vars);
        const body = await resolveTemplate(this.prisma, bodyKey, bodyFallback, vars);
        const outcome = await this.notifyStudentDay(
          student.family_id,
          student.cc,
          calendarRow.date,
          alertType,
          title,
          body,
        );
        if (outcome === 'already_notified') report.already_notified++;
        else report.notified++;
      } catch (err: any) {
        report.failed++;
        report.failures.push({
          student_cc: student.cc,
          family_id: student.family_id,
          student_name: student.full_name,
          reason: err?.message || 'Notification failed',
        });
      }
    }

    return report;
  }

  async notifyFamiliesForCalendarDay(calendarRow: any): Promise<CalendarNotificationReport> {
    return this.notifyScopedStudents(
      calendarRow,
      'HOLIDAY',
      'notif_holiday_title',
      'School Closed',
      'notif_holiday_body',
      '{student_name} — TAFS is closed on {date} for {description}.',
      (student, date, description) => ({
        student_name: student.full_name || 'Student',
        date,
        description,
      }),
    );
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

      try {
        const resolved = await this.calendarResolver.resolveStudentDay(
          campusId,
          student.class_id,
          student.section_id,
          date,
        );

        if (resolved.isWorkingDay) continue;

        if (resolved.dayType === 'HOLIDAY') {
          if (await isTemplateDisabled(this.prisma, 'notif_holiday_title')) continue;
          const rawResolvedDesc = resolved.description || 'Holiday';
          const cleanResolvedDesc = rawResolvedDesc.startsWith('[PINNED] ') ? rawResolvedDesc.replace('[PINNED] ', '') : rawResolvedDesc;
          const vars = { student_name: student.full_name, date: formattedDate, description: cleanResolvedDesc };
          const hTitle = await resolveTemplate(this.prisma, 'notif_holiday_title', 'School Closed', vars);
          const hBody = await resolveTemplate(this.prisma, 'notif_holiday_body',
            '{student_name} — TAFS is closed on {date} for {description}.', vars);
          await this.notifyStudentDay(
            student.family_id,
            student.cc,
            date,
            'HOLIDAY',
            hTitle,
            hBody,
          );
        } else if (resolved.dayType === 'WEEKEND') {
          if (await isTemplateDisabled(this.prisma, 'notif_day_off_title')) continue;
          const vars = { student_name: student.full_name, date: formattedDate };
          const doTitle = await resolveTemplate(this.prisma, 'notif_day_off_title', 'Scheduled Day Off', vars);
          const doBody = await resolveTemplate(this.prisma, 'notif_day_off_body',
            '{student_name} — TAFS is closed on {date} (weekend).', vars);
          await this.notifyStudentDay(
            student.family_id,
            student.cc,
            date,
            'DAY_OFF',
            doTitle,
            doBody,
          );
        }
      } catch (err: any) {
        console.error(
          `[CalendarNotify] Day-off notify failed for student CC ${student.cc}:`,
          err?.message,
        );
      }
    }
  }

  async notifySchoolOpenForCalendarDay(calendarRow: any): Promise<CalendarNotificationReport> {
    return this.notifyScopedStudents(
      calendarRow,
      'SCHOOL_OPEN',
      'notif_school_open_title',
      'School Open',
      'notif_school_open_body',
      '{student_name} — TAFS will be open on {date}.',
      (student, date) => ({
        student_name: student.full_name || 'Student',
        date,
      }),
    );
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
      select: { date: true, campus_id: true, description: true, day_type: true },
    });

    const holidayKey = (date: Date, campusId: number) => `${date.toISOString().slice(0, 10)}-${campusId}`;
    const pinnedHolidays = new Set(
      calendarDays
        .filter((c) => c.description?.startsWith('[PINNED] '))
        .map((c) => holidayKey(c.date, c.campus_id)),
    );

    const activeHolidayKeys = new Set(
      calendarDays
        .filter((c) => c.day_type === 'HOLIDAY')
        .map((c) => holidayKey(c.date, c.campus_id)),
    );

    const validNotifications: typeof notifications = [];
    const orphanedIds: number[] = [];

    for (const n of notifications) {
      if (n.alert_type === 'HOLIDAY') {
        const campusId = n.students?.campus_id;
        const hasActiveHoliday = campusId && activeHolidayKeys.has(holidayKey(n.date, campusId));
        if (!hasActiveHoliday) {
          orphanedIds.push(n.id);
          continue;
        }
      }
      validNotifications.push(n);
    }

    if (orphanedIds.length > 0) {
      this.prisma.calendar_notifications.deleteMany({
        where: { id: { in: orphanedIds } },
      }).catch((err) => console.error('Failed to clean up orphaned notifications:', err));
    }

    return validNotifications.map((n) => {
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
