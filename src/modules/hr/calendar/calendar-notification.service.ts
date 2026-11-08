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

  private async dispatchFcmBatches(
    payloads: Array<{ familyId: number; studentCc: number; title: string; body: string }>,
    date: Date,
    alertType: string,
  ) {
    const BATCH_SIZE = 25;
    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const batch = payloads.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        batch.map((p) =>
          this.fcmService.sendToFamily(p.familyId, p.title, p.body, {
            type: 'calendar_alert',
            student_cc: String(p.studentCc),
            date: date.toISOString(),
            alert_type: alertType,
          }),
        ),
      );
    }
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

    const scopedStudents = students.filter((s) => this.matchesStudentScope(calendarRow, s.class_id, s.section_id));
    for (const s of scopedStudents) {
      if (!s.family_id) {
        report.skipped_no_family++;
      }
    }

    const eligible = scopedStudents.filter((s) => s.family_id != null);
    report.attempted = eligible.length;
    if (eligible.length === 0) return report;

    // Single query to identify who was already notified on this date/alert_type
    const eligibleFamilyIds = [...new Set(eligible.map((s) => s.family_id!))];
    const eligibleCcs = eligible.map((s) => s.cc);

    const existingRows = await this.prisma.calendar_notifications.findMany({
      where: {
        family_id: { in: eligibleFamilyIds },
        student_cc: { in: eligibleCcs },
        date: calendarRow.date,
        alert_type: alertType,
      },
      select: { family_id: true, student_cc: true },
    });
    const existingSet = new Set(existingRows.map((r) => `${r.family_id}:${r.student_cc}`));

    const toNotify: typeof eligible = [];
    for (const s of eligible) {
      if (existingSet.has(`${s.family_id}:${s.cc}`)) {
        report.already_notified++;
      } else {
        toNotify.push(s);
      }
    }

    if (toNotify.length === 0) return report;

    const toInsert: Array<{
      family_id: number;
      student_cc: number;
      date: Date;
      alert_type: string;
      title: string;
      body: string;
    }> = [];

    const fcmPayloads: Array<{
      familyId: number;
      studentCc: number;
      title: string;
      body: string;
    }> = [];

    for (const student of toNotify) {
      try {
        const vars = buildVars(student, formattedDate, cleanDesc);
        const title = await resolveTemplate(this.prisma, titleKey, titleFallback, vars);
        const body = await resolveTemplate(this.prisma, bodyKey, bodyFallback, vars);
        toInsert.push({
          family_id: student.family_id!,
          student_cc: student.cc,
          date: calendarRow.date,
          alert_type: alertType,
          title,
          body,
        });
        fcmPayloads.push({
          familyId: student.family_id!,
          studentCc: student.cc,
          title,
          body,
        });
      } catch (err: any) {
        report.failed++;
        report.failures.push({
          student_cc: student.cc,
          family_id: student.family_id!,
          student_name: student.full_name,
          reason: err?.message || 'Failed to prepare notification',
        });
      }
    }

    const CHUNK_SIZE = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      try {
        const inserted = await this.prisma.calendar_notifications.createMany({
          data: chunk,
          skipDuplicates: true,
        });
        report.notified += inserted.count;
        report.already_notified += chunk.length - inserted.count;
      } catch (err: any) {
        report.failed += chunk.length;
        for (const item of chunk) {
          report.failures.push({
            student_cc: item.student_cc,
            family_id: item.family_id,
            reason: err?.message || 'Database insert failed',
          });
        }
      }
    }

    // Fire-and-forget push notification delivery without blocking HTTP thread
    if (fcmPayloads.length > 0) {
      void this.dispatchFcmBatches(fcmPayloads, calendarRow.date, alertType).catch((err) =>
        console.error('[CalendarNotify] Background FCM dispatch error:', err?.message),
      );
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

    const rows = await this.calendarResolver.loadStudentCalendarRowsForDate(campusId, date);
    const clearStudentCcs: number[] = [];

    for (const student of students) {
      if (!student.family_id) continue;

      const resolved = this.calendarResolver.resolveStudentDayFromRows(
        rows,
        student.class_id,
        student.section_id,
        date,
      );
      if (resolved.isWorkingDay) {
        clearStudentCcs.push(student.cc);
      }
    }

    if (clearStudentCcs.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < clearStudentCcs.length; i += CHUNK) {
        await this.prisma.calendar_notifications.deleteMany({
          where: {
            student_cc: { in: clearStudentCcs.slice(i, i + CHUNK) },
            date,
            alert_type: { in: ['HOLIDAY', 'DAY_OFF'] },
          },
        });
      }
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

    const rows = await this.calendarResolver.loadStudentCalendarRowsForDate(campusId, date);
    const formattedDate = formatDatePKT(date);
    const holidayDisabled = await isTemplateDisabled(this.prisma, 'notif_holiday_title');
    const weekendDisabled = await isTemplateDisabled(this.prisma, 'notif_day_off_title');

    const eligibleStudents: Array<{
      student: typeof students[0];
      alertType: 'HOLIDAY' | 'DAY_OFF';
      resolvedDesc: string;
    }> = [];

    for (const student of students) {
      if (!student.family_id) continue;
      const resolved = this.calendarResolver.resolveStudentDayFromRows(
        rows,
        student.class_id,
        student.section_id,
        date,
      );
      if (resolved.isWorkingDay) continue;

      if (resolved.dayType === 'HOLIDAY' && !holidayDisabled) {
        const rawResolvedDesc = resolved.description || 'Holiday';
        const cleanResolvedDesc = rawResolvedDesc.startsWith('[PINNED] ') ? rawResolvedDesc.replace('[PINNED] ', '') : rawResolvedDesc;
        eligibleStudents.push({
          student,
          alertType: 'HOLIDAY',
          resolvedDesc: cleanResolvedDesc,
        });
      } else if (resolved.dayType === 'WEEKEND' && !weekendDisabled) {
        eligibleStudents.push({
          student,
          alertType: 'DAY_OFF',
          resolvedDesc: 'Scheduled Day Off',
        });
      }
    }

    if (eligibleStudents.length === 0) return;

    // Check existing notifications in one batch query
    const familyIds = [...new Set(eligibleStudents.map((e) => e.student.family_id!))];
    const studentCcs = eligibleStudents.map((e) => e.student.cc);
    const existing = await this.prisma.calendar_notifications.findMany({
      where: {
        family_id: { in: familyIds },
        student_cc: { in: studentCcs },
        date,
        alert_type: { in: ['HOLIDAY', 'DAY_OFF'] },
      },
      select: { family_id: true, student_cc: true, alert_type: true },
    });
    const existingSet = new Set(existing.map((e) => `${e.family_id}:${e.student_cc}:${e.alert_type}`));

    const toInsert: Array<{
      family_id: number;
      student_cc: number;
      date: Date;
      alert_type: string;
      title: string;
      body: string;
    }> = [];
    const fcmPayloads: Array<{
      familyId: number;
      studentCc: number;
      alertType: string;
      title: string;
      body: string;
    }> = [];

    for (const item of eligibleStudents) {
      const { student, alertType, resolvedDesc } = item;
      const key = `${student.family_id}:${student.cc}:${alertType}`;
      if (existingSet.has(key)) continue;

      try {
        let title = '';
        let body = '';
        if (alertType === 'HOLIDAY') {
          const vars = { student_name: student.full_name || 'Student', date: formattedDate, description: resolvedDesc };
          title = await resolveTemplate(this.prisma, 'notif_holiday_title', 'School Closed', vars);
          body = await resolveTemplate(this.prisma, 'notif_holiday_body', '{student_name} — TAFS is closed on {date} for {description}.', vars);
        } else {
          const vars = { student_name: student.full_name || 'Student', date: formattedDate };
          title = await resolveTemplate(this.prisma, 'notif_day_off_title', 'Scheduled Day Off', vars);
          body = await resolveTemplate(this.prisma, 'notif_day_off_body', '{student_name} — TAFS is closed on {date} (weekend).', vars);
        }
        toInsert.push({
          family_id: student.family_id!,
          student_cc: student.cc,
          date,
          alert_type: alertType,
          title,
          body,
        });
        fcmPayloads.push({
          familyId: student.family_id!,
          studentCc: student.cc,
          alertType,
          title,
          body,
        });
      } catch (err: any) {
        console.error(`[CalendarNotify] Day-off notify prepare failed for student CC ${student.cc}:`, err?.message);
      }
    }

    if (toInsert.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < toInsert.length; i += CHUNK) {
        await this.prisma.calendar_notifications.createMany({
          data: toInsert.slice(i, i + CHUNK),
          skipDuplicates: true,
        });
      }
    }

    if (fcmPayloads.length > 0) {
      void this.dispatchFcmBatches(
        fcmPayloads.map((p) => ({
          familyId: p.familyId,
          studentCc: p.studentCc,
          title: p.title,
          body: p.body,
        })),
        date,
        fcmPayloads[0].alertType,
      ).catch((err) => console.error('[CalendarNotify] Background FCM dispatch failed:', err?.message));
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
