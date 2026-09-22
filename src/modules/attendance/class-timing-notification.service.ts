import { Injectable, Logger } from '@nestjs/common';
import { student_status } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { resolveTemplate, isTemplateDisabled } from '../../utils/notification-templates.util';

export type ClassTimingNotificationFailure = {
  family_id: number;
  student_names: string;
  reason: string;
};

export type ClassTimingNotificationReport = {
  /** Enrolled students in the pairing, whether or not they could be reached. */
  students_matched: number;
  families_notified: number;
  skipped_no_family: number;
  failed: number;
  failures: ClassTimingNotificationFailure[];
  /** Populated when the announcement was recorded; null when nothing was sent. */
  notification_id: number | null;
};

export function emptyClassTimingReport(): ClassTimingNotificationReport {
  return {
    students_matched: 0,
    families_notified: 0,
    skipped_no_family: 0,
    failed: 0,
    failures: [],
    notification_id: null,
  };
}

/** One-line summary for the settings page's banner. */
export function formatClassTimingReport(
  report: ClassTimingNotificationReport | null | undefined,
): string | null {
  if (!report) return null;
  if (report.students_matched === 0) {
    return 'Notifications: no enrolled students in this class at this campus';
  }
  const parts = [
    `Notifications: ${report.families_notified} family(ies) notified for ${report.students_matched} student(s)`,
  ];
  if (report.skipped_no_family > 0) {
    parts.push(`${report.skipped_no_family} with no family link skipped`);
  }
  if (report.failed > 0) {
    const sample = report.failures
      .slice(0, 3)
      .map((f) => `${f.student_names}${f.reason ? ` (${f.reason})` : ''}`)
      .join('; ');
    parts.push(`${report.failed} failed${sample ? `: ${sample}` : ''}`);
  }
  return parts.join(' · ');
}

/** "14:30" from a Prisma `@db.Time` column. */
export function formatScheduleTime(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(11, 16);
}

/** "2:30 PM" — what a parent reads, rather than a 24-hour clock. */
function formatTimeForParent(value: Date): string {
  const hours = value.getUTCHours();
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');
  const suffix = hours < 12 ? 'AM' : 'PM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${minutes} ${suffix}`;
}

function formatDatePKT(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * Tells parents that a campus+class pairing's school-day timings changed.
 *
 * ONLY the start and end times go out. The intermediate time is an internal
 * punch-direction threshold — it is never in the body, never in the FCM data
 * payload, and is not stored on the announcement row, so there is no route by
 * which a later change to this code could start leaking it.
 *
 * Sending is opt-in per save: an admin ticks "Notify parents" in the schedule
 * dialog. An untickled save changes the timings silently, which is what you
 * want while setting a pairing up for the first time or correcting a typo.
 */
@Injectable()
export class ClassTimingNotificationService {
  private readonly logger = new Logger(ClassTimingNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fcmService: FcmService,
  ) {}

  /** The exact text parents will receive — also used for the dialog's preview. */
  async buildMessage(input: {
    className: string;
    campusName: string;
    startTime: Date;
    endTime: Date | null;
    effectiveFrom: Date;
  }): Promise<{ title: string; body: string }> {
    const vars: Record<string, string> = {
      class_name: input.className,
      campus_name: input.campusName,
      start_time: formatTimeForParent(input.startTime),
      end_time: input.endTime ? formatTimeForParent(input.endTime) : '—',
      effective_from: formatDatePKT(input.effectiveFrom),
    };

    const title = await resolveTemplate(
      this.prisma,
      'notif_class_timings_title',
      'School Timings Updated',
      vars,
    );
    const body = await resolveTemplate(
      this.prisma,
      'notif_class_timings_body',
      input.endTime
        ? '{class_name} at {campus_name} will run from {start_time} to {end_time}, effective {effective_from}.'
        : '{class_name} at {campus_name} will start at {start_time}, effective {effective_from}.',
      vars,
    );
    return { title, body };
  }

  /**
   * Fan the announcement out to every enrolled student in the pairing.
   *
   * Grouped by family: a household with two children in the same class gets one
   * push, naming both, rather than the same sentence twice.
   */
  async notifyPairing(input: {
    scheduleId: number | null;
    campusId: number;
    classId: number;
    startTime: Date;
    endTime: Date | null;
    effectiveFrom: Date;
    createdBy?: string | null;
  }): Promise<ClassTimingNotificationReport> {
    const report = emptyClassTimingReport();

    if (await isTemplateDisabled(this.prisma, 'notif_class_timings_title')) {
      this.logger.log(
        `Class timing notification suppressed for campus ${input.campusId} class ${input.classId}: template disabled`,
      );
      return report;
    }

    const [students, campus, klass] = await Promise.all([
      this.prisma.students.findMany({
        where: {
          campus_id: input.campusId,
          class_id: input.classId,
          status: student_status.ENROLLED,
          deleted_at: null,
        },
        select: { cc: true, full_name: true, family_id: true },
      }),
      this.prisma.campuses.findUnique({
        where: { id: input.campusId },
        select: { campus_name: true },
      }),
      this.prisma.classes.findUnique({
        where: { id: input.classId },
        select: { description: true },
      }),
    ]);

    report.students_matched = students.length;
    if (students.length === 0) return report;

    const byFamily = new Map<number, string[]>();
    for (const student of students) {
      if (!student.family_id) {
        report.skipped_no_family++;
        continue;
      }
      const names = byFamily.get(student.family_id) ?? [];
      names.push(student.full_name ?? `CC ${student.cc}`);
      byFamily.set(student.family_id, names);
    }

    const { title, body } = await this.buildMessage({
      className: klass?.description ?? `Class #${input.classId}`,
      campusName: campus?.campus_name ?? `Campus #${input.campusId}`,
      startTime: input.startTime,
      endTime: input.endTime,
      effectiveFrom: input.effectiveFrom,
    });

    // Recorded before the pushes go out, so the row exists even if delivery
    // stumbles — a push nobody can account for is worse than a counted failure.
    const row = await this.prisma.class_timing_notifications.create({
      data: {
        schedule_id: input.scheduleId,
        campus_id: input.campusId,
        class_id: input.classId,
        start_time: input.startTime,
        end_time: input.endTime,
        effective_from: input.effectiveFrom,
        students_matched: students.length,
        title,
        body,
        created_by: input.createdBy ?? null,
      },
    });
    report.notification_id = row.id;

    for (const [familyId, names] of byFamily) {
      try {
        // sendToFamily swallows FCM failures — the announcement row is the
        // durable record, exactly as it is for calendar alerts.
        await this.fcmService.sendToFamily(familyId, title, body, {
          type: 'class_timings_updated',
          notification_id: String(row.id),
          campus_id: String(input.campusId),
          class_id: String(input.classId),
          effective_from: input.effectiveFrom.toISOString().slice(0, 10),
          // Start and end only — the intermediate time is internal.
          start_time: formatScheduleTime(input.startTime)!,
          ...(input.endTime ? { end_time: formatScheduleTime(input.endTime)! } : {}),
          title,
          body,
        });
        report.families_notified++;
      } catch (err: any) {
        report.failed++;
        report.failures.push({
          family_id: familyId,
          student_names: names.join(', '),
          reason: err?.message || 'Notification failed',
        });
      }
    }

    await this.prisma.class_timing_notifications.update({
      where: { id: row.id },
      data: { families_notified: report.families_notified },
    });

    return report;
  }

  /** The most recent announcement for a pairing, for the settings page. */
  async lastForPairing(campusId: number, classId: number) {
    return this.prisma.class_timing_notifications.findFirst({
      where: { campus_id: campusId, class_id: classId },
      orderBy: { created_at: 'desc' },
    });
  }
}
