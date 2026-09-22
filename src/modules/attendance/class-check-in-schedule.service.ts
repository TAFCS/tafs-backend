import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ScopeService } from '../../common/scope/scope.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
  ClassTimingNotificationService,
  ClassTimingNotificationReport,
  formatClassTimingReport,
  formatScheduleTime,
} from './class-timing-notification.service';

const toTime = (value?: string | null) => (value ? new Date(`1970-01-01T${value}:00Z`) : null);
const fmtTime = (d: Date | null | undefined) => (d ? d.toISOString().slice(11, 16) : '—');

import { IsArray, IsBoolean, IsDateString, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** "HH:MM" or "HH:MM:SS" — what an <input type="time"> sends. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class CreateClassScheduleDto {
  @IsInt()
  class_id: number;

  @IsInt()
  campus_id: number;

  /** START of the school day, and the threshold LATE is measured from. */
  @IsString()
  @Matches(TIME_PATTERN, { message: 'expected_check_in must be HH:MM' })
  expected_check_in: string;

  /** END of the school day. Shown to parents alongside the start. */
  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'end_time must be HH:MM' })
  end_time?: string | null;

  /** Internal punch-direction threshold. Never shown to parents. */
  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'intermediate_time must be HH:MM' })
  intermediate_time?: string | null;

  @IsDateString()
  effective_from: string;

  /** Weekday overrides. Omitted means none. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleDayDto)
  days?: ScheduleDayDto[];

  /** Opt-in per save — see ClassTimingNotificationService. */
  @IsOptional()
  @IsBoolean()
  notify_parents?: boolean;
}

export class UpdateClassScheduleDto {
  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'expected_check_in must be HH:MM' })
  expected_check_in?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'end_time must be HH:MM' })
  end_time?: string | null;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'intermediate_time must be HH:MM' })
  intermediate_time?: string | null;

  @IsOptional()
  @IsDateString()
  effective_from?: string;

  /**
   * Replaces the whole override set when present. An empty array clears every
   * override; omitting the key leaves them untouched.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleDayDto)
  days?: ScheduleDayDto[];

  @IsOptional()
  @IsBoolean()
  notify_parents?: boolean;
}

/** One weekday that runs to different times. Replaces the base for that day. */
export class ScheduleDayDto {
  /** 0 = Sunday … 6 = Saturday. */
  @IsInt()
  @Min(0)
  @Max(6)
  day_of_week: number;

  @IsString()
  @Matches(TIME_PATTERN, { message: 'expected_check_in must be HH:MM' })
  expected_check_in: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'end_time must be HH:MM' })
  end_time?: string | null;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'intermediate_time must be HH:MM' })
  intermediate_time?: string | null;
}

const SCHEDULE_INCLUDE = {
  classes: { select: { id: true, description: true, class_code: true } },
  class_check_in_schedule_days: { orderBy: { day_of_week: 'asc' } },
} as const;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

@Injectable()
export class ClassCheckInScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly scope: ScopeService,
    private readonly timingNotifications: ClassTimingNotificationService,
  ) {}

  /**
   * The caller must be able to act on this campus (and class): universal scope
   * AND the legacy campus field older tokens still carry. `user` omitted means
   * an internal caller.
   */
  private assertCampus(user: IJwtStaffPayload | undefined, campusId: number | null | undefined, classId?: number | null) {
    if (!user) return;
    this.scope.assertCampus(user, campusId ?? null);
    if (user.campusId != null && campusId != null && campusId !== user.campusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }
    if (classId != null) this.scope.assertClass(user, classId);
  }

  async findAll(campusId: number, user?: IJwtStaffPayload) {
    this.assertCampus(user, campusId);
    const schedules = await this.prisma.class_check_in_schedules.findMany({
      where: { campus_id: campusId },
      include: SCHEDULE_INCLUDE,
      orderBy: { effective_from: 'desc' },
    });

    // What was last announced, so the settings page can show whether parents
    // have been told about the timings currently on screen.
    const announcements = await this.prisma.class_timing_notifications.findMany({
      where: { campus_id: campusId },
      orderBy: { created_at: 'desc' },
    });
    const lastByClass = new Map<number, (typeof announcements)[number]>();
    for (const row of announcements) {
      if (!lastByClass.has(row.class_id)) lastByClass.set(row.class_id, row);
    }

    return schedules.map((schedule) => {
      const last = lastByClass.get(schedule.class_id) ?? null;
      return {
        ...schedule,
        last_notified_at: last?.created_at ?? null,
        last_notified_start: formatScheduleTime(last?.start_time),
        last_notified_end: formatScheduleTime(last?.end_time),
        /**
         * True when the live start/end differ from what parents were last told
         * — including the never-announced case. Drives the "not announced"
         * badge; the intermediate time deliberately does not count, since
         * changing it tells parents nothing.
         */
        parents_out_of_date:
          formatScheduleTime(schedule.expected_check_in) !== (last?.start_time ? formatScheduleTime(last.start_time) : null) ||
          formatScheduleTime(schedule.end_time) !== (last?.end_time ? formatScheduleTime(last.end_time) : null),
      };
    });
  }

  async findOne(id: number, user?: IJwtStaffPayload) {
    const schedule = await this.prisma.class_check_in_schedules.findUnique({
      where: { id },
      include: SCHEDULE_INCLUDE,
    });
    // Missing and out-of-scope both 404.
    let visible = !!schedule;
    if (schedule && user) {
      try {
        this.assertCampus(user, schedule.campus_id, schedule.class_id);
      } catch {
        visible = false;
      }
    }
    if (!schedule || !visible) {
      throw new NotFoundException(`Check-in schedule with ID ${id} not found`);
    }
    return schedule;
  }

  /**
   * The day has to read left to right: start, then the internal cut-off, then
   * end. An intermediate time outside that window would silently break the
   * punch rule — before the start, every punch of the day becomes a check-out;
   * after the end, none ever does.
   */
  private assertTimesOrdered(start: Date, intermediate: Date | null, end: Date | null): void {
    if (end && end <= start) {
      throw new BadRequestException('End time must be after the start time');
    }
    if (intermediate) {
      if (intermediate <= start) {
        throw new BadRequestException('Intermediate time must be after the start time');
      }
      if (end && intermediate >= end) {
        throw new BadRequestException('Intermediate time must be before the end time');
      }
    }
  }

  /**
   * A pairing is campus + class + effective date.
   *
   * Classes are shared across campuses (campus_classes), so leaving the campus
   * out here — as this check used to — rejected a perfectly valid schedule for
   * Class VI at a second campus because the first campus already had one.
   */
  private async assertNoDuplicate(
    campusId: number,
    classId: number,
    effectiveFrom: Date,
    exceptId?: number,
  ): Promise<void> {
    const duplicate = await this.prisma.class_check_in_schedules.findFirst({
      where: {
        campus_id: campusId,
        class_id: classId,
        effective_from: effectiveFrom,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
    });
    if (duplicate) {
      throw new BadRequestException(
        'A schedule for this class at this campus starting on this date already exists',
      );
    }
  }

  /**
   * Replace a schedule's weekday overrides.
   *
   * Each day is validated against its own times, not the base's — a Friday
   * that ends at 11:30 needs its cut-off inside *Friday*, and checking it
   * against the ordinary day's window would reject a perfectly good row.
   */
  private async replaceDays(scheduleId: number, days: ScheduleDayDto[]): Promise<void> {
    const seen = new Set<number>();
    for (const day of days) {
      if (seen.has(day.day_of_week)) {
        throw new BadRequestException(`Duplicate override for ${DAY_NAMES[day.day_of_week]}`);
      }
      seen.add(day.day_of_week);

      const start = toTime(day.expected_check_in);
      if (!start) {
        throw new BadRequestException(`Invalid start time for ${DAY_NAMES[day.day_of_week]}`);
      }
      try {
        this.assertTimesOrdered(start, toTime(day.intermediate_time), toTime(day.end_time));
      } catch (err: any) {
        throw new BadRequestException(`${DAY_NAMES[day.day_of_week]}: ${err.message}`);
      }
    }

    await this.prisma.$transaction([
      this.prisma.class_check_in_schedule_days.deleteMany({ where: { schedule_id: scheduleId } }),
      ...days.map((day) =>
        this.prisma.class_check_in_schedule_days.create({
          data: {
            schedule_id: scheduleId,
            day_of_week: day.day_of_week,
            expected_check_in: toTime(day.expected_check_in)!,
            end_time: toTime(day.end_time),
            intermediate_time: toTime(day.intermediate_time),
          },
        }),
      ),
    ]);
  }

  /** "Fri 08:00–11:30" per override, for the audit note. */
  private describeDays(days: ScheduleDayDto[]): string {
    if (days.length === 0) return 'none';
    return days
      .map((d) => `${DAY_NAMES[d.day_of_week]} ${d.expected_check_in}–${d.end_time ?? '—'}`)
      .join(', ');
  }

  private startOfDay(value: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid effective_from date');
    }
    date.setUTCHours(0, 0, 0, 0);
    return date;
  }

  /**
   * Announce the pairing's timings, when the admin asked for it.
   *
   * Never throws: the schedule is already saved and is what the punch pipeline
   * reads, so a notification failure must not roll it back or 500 the request.
   * It comes back as a warning the UI shows instead.
   */
  private async announceIfRequested(
    notify: boolean | undefined,
    schedule: { id: number; campus_id: number; class_id: number; expected_check_in: Date; end_time: Date | null; effective_from: Date },
    actor?: string,
  ): Promise<{ report: ClassTimingNotificationReport | null; warning: string | null }> {
    if (!notify) return { report: null, warning: null };

    try {
      const report = await this.timingNotifications.notifyPairing({
        scheduleId: schedule.id,
        campusId: schedule.campus_id,
        classId: schedule.class_id,
        startTime: schedule.expected_check_in,
        endTime: schedule.end_time,
        effectiveFrom: schedule.effective_from,
        createdBy: actor ?? null,
      });

      await this.auditLogs.log({
        entity_type: 'CLASS_CHECK_IN_SCHEDULE',
        entity_id: String(schedule.id),
        action: 'NOTIFIED',
        changed_by: actor ?? 'system',
        note:
          `Parents notified of timings for schedule #${schedule.id}: ` +
          `${report.families_notified} family(ies) across ${report.students_matched} student(s)` +
          (report.skipped_no_family ? `, ${report.skipped_no_family} with no family link` : '') +
          (report.failed ? `, ${report.failed} failed` : '') +
          '.',
      });

      return { report, warning: formatClassTimingReport(report) };
    } catch (err: any) {
      return {
        report: null,
        warning: `Timings saved, but parents could not be notified: ${err?.message ?? 'unknown error'}`,
      };
    }
  }

  async create(dto: CreateClassScheduleDto, createdBy?: string, changedBy?: string, user?: IJwtStaffPayload) {
    this.assertCampus(user, dto.campus_id, dto.class_id);
    const effectiveFrom = this.startOfDay(dto.effective_from);
    await this.assertNoDuplicate(dto.campus_id, dto.class_id, effectiveFrom);

    const start = toTime(dto.expected_check_in);
    if (!start) {
      throw new BadRequestException('Invalid expected_check_in format');
    }
    const end = toTime(dto.end_time);
    const intermediate = toTime(dto.intermediate_time);
    this.assertTimesOrdered(start, intermediate, end);

    const record = await this.prisma.class_check_in_schedules.create({
      data: {
        class_id: dto.class_id,
        campus_id: dto.campus_id,
        expected_check_in: start,
        end_time: end,
        intermediate_time: intermediate,
        effective_from: effectiveFrom,
        created_by: createdBy ?? null,
      },
      include: SCHEDULE_INCLUDE,
    });

    const classLabel = record.classes
      ? `${record.classes.class_code} – ${record.classes.description}`
      : `#${dto.class_id}`;
    await this.auditLogs.log({
      entity_type: 'CLASS_CHECK_IN_SCHEDULE',
      entity_id: String(record.id),
      action: 'CREATED',
      changed_by: changedBy ?? createdBy ?? 'system',
      note:
        `Check-in schedule #${record.id} for class ${classLabel} at campus #${dto.campus_id}: ` +
        `start ${fmtTime(start)}, end ${fmtTime(end)}, cut-off ${fmtTime(intermediate)}, ` +
        `effective ${effectiveFrom.toISOString().slice(0, 10)}.`,
    });

    if (dto.days?.length) {
      await this.replaceDays(record.id, dto.days);
      await this.auditLogs.log({
        entity_type: 'CLASS_CHECK_IN_SCHEDULE',
        entity_id: String(record.id),
        action: 'UPDATED',
        changed_by: changedBy ?? createdBy ?? 'system',
        note: `Check-in schedule #${record.id} day overrides set: ${this.describeDays(dto.days)}.`,
      });
    }

    const announced = await this.announceIfRequested(
      dto.notify_parents,
      record,
      changedBy ?? createdBy,
    );
    const withDays = await this.findOne(record.id);
    return { ...withDays, notification_report: announced.report, notification_warning: announced.warning };
  }

  async update(id: number, dto: UpdateClassScheduleDto, changedBy?: string, user?: IJwtStaffPayload) {
    const existing = await this.findOne(id, user);

    const data: {
      expected_check_in?: Date;
      end_time?: Date | null;
      intermediate_time?: Date | null;
      effective_from?: Date;
    } = {};

    if (dto.expected_check_in !== undefined) {
      const start = toTime(dto.expected_check_in);
      if (!start) {
        throw new BadRequestException('Invalid expected_check_in format');
      }
      data.expected_check_in = start;
    }
    // An explicit null clears the time; an absent key leaves it alone.
    if (dto.end_time !== undefined) {
      data.end_time = toTime(dto.end_time);
    }
    if (dto.intermediate_time !== undefined) {
      data.intermediate_time = toTime(dto.intermediate_time);
    }

    // Validate the row as it will be, not just the fields that came in — a
    // partial edit can put a previously fine intermediate time out of bounds.
    this.assertTimesOrdered(
      data.expected_check_in ?? existing.expected_check_in,
      dto.intermediate_time !== undefined ? data.intermediate_time! : existing.intermediate_time,
      dto.end_time !== undefined ? data.end_time! : existing.end_time,
    );

    if (dto.effective_from !== undefined) {
      const effectiveFrom = this.startOfDay(dto.effective_from);
      await this.assertNoDuplicate(existing.campus_id, existing.class_id, effectiveFrom, id);
      data.effective_from = effectiveFrom;
    }

    const updated = await this.prisma.class_check_in_schedules.update({
      where: { id },
      data,
      include: SCHEDULE_INCLUDE,
    });

    const changes: string[] = [];
    if (fmtTime(existing.expected_check_in) !== fmtTime(updated.expected_check_in)) {
      changes.push(`start ${fmtTime(existing.expected_check_in)} → ${fmtTime(updated.expected_check_in)}`);
    }
    if (fmtTime(existing.end_time) !== fmtTime(updated.end_time)) {
      changes.push(`end ${fmtTime(existing.end_time)} → ${fmtTime(updated.end_time)}`);
    }
    if (fmtTime(existing.intermediate_time) !== fmtTime(updated.intermediate_time)) {
      changes.push(`cut-off ${fmtTime(existing.intermediate_time)} → ${fmtTime(updated.intermediate_time)}`);
    }
    const oldEff = existing.effective_from.toISOString().slice(0, 10);
    const newEff = updated.effective_from.toISOString().slice(0, 10);
    if (oldEff !== newEff) {
      changes.push(`effective ${oldEff} → ${newEff}`);
    }

    // Written before the audit log, so a day-override-only edit is still
    // recorded — the change list is what the note is built from.
    if (dto.days !== undefined) {
      await this.replaceDays(id, dto.days);
      changes.push(`day overrides → ${this.describeDays(dto.days)}`);
    }

    if (changes.length > 0) {
      await this.auditLogs.log({
        entity_type: 'CLASS_CHECK_IN_SCHEDULE',
        entity_id: String(id),
        action: 'UPDATED',
        changed_by: changedBy ?? 'system',
        note: `Check-in schedule #${id} updated: ${changes.join(', ')}.`,
      });
    }

    const announced = await this.announceIfRequested(dto.notify_parents, updated, changedBy);
    const withDays = await this.findOne(id);
    return { ...withDays, notification_report: announced.report, notification_warning: announced.warning };
  }

  async remove(id: number, changedBy?: string, user?: IJwtStaffPayload) {
    const existing = await this.findOne(id, user);
    await this.prisma.class_check_in_schedules.delete({
      where: { id },
    });

    const classLabel = existing.classes
      ? `${existing.classes.class_code} – ${existing.classes.description}`
      : `#${existing.class_id}`;
    await this.auditLogs.log({
      entity_type: 'CLASS_CHECK_IN_SCHEDULE',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: changedBy ?? 'system',
      note:
        `Check-in schedule #${id} for class ${classLabel} at campus #${existing.campus_id} ` +
        `(effective ${existing.effective_from.toISOString().slice(0, 10)}, start ${fmtTime(existing.expected_check_in)}, ` +
        `end ${fmtTime(existing.end_time)}, cut-off ${fmtTime(existing.intermediate_time)}) deleted.`,
    });

    return existing;
  }

  /**
   * The exact message parents would receive, for the dialog's preview. Nothing
   * is sent and nothing is recorded — the admin sees the wording before
   * committing to it.
   *
   * Scoped like the writes: it reveals a campus+class's enrolled-family count,
   * which is not something an out-of-scope caller should be able to probe.
   */
  async previewNotification(
    input: {
      campusId: number;
      classId: number;
      expectedCheckIn: string;
      endTime?: string | null;
      effectiveFrom: string;
    },
    user?: IJwtStaffPayload,
  ) {
    this.assertCampus(user, input.campusId, input.classId);

    const start = toTime(input.expectedCheckIn);
    if (!start) {
      throw new BadRequestException('Invalid expected_check_in format');
    }

    const [campus, klass, recipients] = await Promise.all([
      this.prisma.campuses.findUnique({
        where: { id: input.campusId },
        select: { campus_name: true },
      }),
      this.prisma.classes.findUnique({
        where: { id: input.classId },
        select: { description: true },
      }),
      this.prisma.students.count({
        where: {
          campus_id: input.campusId,
          class_id: input.classId,
          status: 'ENROLLED',
          deleted_at: null,
          family_id: { not: null },
        },
      }),
    ]);

    const message = await this.timingNotifications.buildMessage({
      className: klass?.description ?? `Class #${input.classId}`,
      campusName: campus?.campus_name ?? `Campus #${input.campusId}`,
      startTime: start,
      endTime: toTime(input.endTime),
      effectiveFrom: this.startOfDay(input.effectiveFrom),
    });

    return { ...message, recipients };
  }
}
