import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CheckInSource, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import {
  parseHhmm,
  timingsKey,
  timingsSnapshotFrom,
  WEEKDAY_SHORT,
  type EmployeeTimingsSnapshot,
} from './employee-day-timings.util';

type Tx = Prisma.TransactionClient;

/** What a timings change may set; anything omitted keeps its current value. */
export type TimingsChangeInput = {
  effective_from?: string;
  check_in_source?: 'FIXED' | 'TIMETABLE';
  reporting_time?: string | null;
  leaving_time?: string | null;
  late_relaxation_minutes?: number | null;
  /** Worked weekdays (0 = Sunday), or null for the default pattern of days_per_week. */
  working_days?: number[] | null;
  days_per_week?: number | null;
  day_timings?: { day_of_week: number; reporting_time?: string | null; leaving_time?: string | null }[];
  /** TAFSD-439: change only these weekdays (both times null puts that day back to normal); other days keep theirs. */
  day_timing_patch?: { day_of_week: number; reporting_time: string | null; leaving_time: string | null }[];
  notes?: string | null;
  /**
   * TAFSD-439: a back-dated change normally stops at a later timings change.
   * With this set it applies anyway: the fields it changes are written from
   * its date and through every later period, which keep everything else.
   */
  override_later_changes?: boolean;
};

export type TimingsChangeResult = {
  status: 'APPLIED' | 'SCHEDULED' | 'UNCHANGED';
  effective_from: string;
  warnings: string[];
};

const PROFILE_TIMINGS_INCLUDE = {
  employee_work_schedules: { select: { day_of_week: true, is_working: true } },
  employee_day_timings: { select: { day_of_week: true, reporting_time: true, leaving_time: true } },
} as const;

/** Today in Pakistan time, YYYY-MM-DD. */
export function todayPkt(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
}

/** Midnight at the start of a PKT calendar day, as an instant (UTC 19:00 the day before). */
export function pktDayStart(isoDate: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 5 * 60 * 60 * 1000);
}

function formatDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "In 07:30 → 07:00, Fri normal → 07:30–12:00" between two snapshots. */
export function describeTimingsChange(a: EmployeeTimingsSnapshot, b: EmployeeTimingsSnapshot): string {
  const v = (x: unknown) => (x == null || x === '' ? '—' : String(x));
  const out: string[] = [];
  const cmp = (label: string, x: unknown, y: unknown) => {
    if (v(x) !== v(y)) out.push(`${label} ${v(x)} → ${v(y)}`);
  };
  const days = (t: EmployeeTimingsSnapshot) =>
    t.working_days ? t.working_days.map((d) => WEEKDAY_SHORT[d]).join(' ') : t.days_per_week ? `${t.days_per_week} days/wk` : null;
  cmp('Source', a.check_in_source, b.check_in_source);
  cmp('In', a.reporting_time, b.reporting_time);
  cmp('Out', a.leaving_time, b.leaving_time);
  cmp('Grace', a.late_relaxation_minutes, b.late_relaxation_minutes);
  cmp('Days', days(a), days(b));
  for (let d = 0; d < 7; d++) {
    const fmt = (t: EmployeeTimingsSnapshot) => {
      const r = t.day_timings?.find((x) => x.day_of_week === d);
      return r ? `${r.reporting_time ?? 'normal'}–${r.leaving_time ?? 'normal'}` : 'normal';
    };
    if (fmt(a) !== fmt(b)) out.push(`${WEEKDAY_SHORT[d]} ${fmt(a)} → ${fmt(b)}`);
  }
  return out.join(', ');
}

/** The default working-day pattern for a days_per_week count (Mon–Fri, then Sat, then Sun). */
function defaultPattern(n: number): number[] {
  const days = [1, 2, 3, 4, 5];
  if (n >= 6) days.push(6);
  if (n >= 7) days.push(0);
  return days.slice(0, Math.max(n, 0)).sort((a, b) => a - b);
}

/**
 * TAFSD-439: only what a change actually alters, as an input that can be
 * merged onto any other snapshot — so an override touches just those fields
 * in later periods and leaves the rest of each later change alone.
 */
export function timingsDelta(current: EmployeeTimingsSnapshot, next: EmployeeTimingsSnapshot): TimingsChangeInput {
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const delta: TimingsChangeInput = {};
  if (!same(current.check_in_source, next.check_in_source)) delta.check_in_source = next.check_in_source as 'FIXED' | 'TIMETABLE';
  if (!same(current.reporting_time, next.reporting_time)) delta.reporting_time = next.reporting_time;
  if (!same(current.leaving_time, next.leaving_time)) delta.leaving_time = next.leaving_time;
  if (!same(current.late_relaxation_minutes, next.late_relaxation_minutes)) delta.late_relaxation_minutes = next.late_relaxation_minutes;
  if (
    !same(current.days_per_week, next.days_per_week) ||
    JSON.stringify(current.working_days ?? null) !== JSON.stringify(next.working_days ?? null)
  ) {
    delta.days_per_week = next.days_per_week;
    delta.working_days = next.working_days ?? null;
  }
  const dayOf = (t: EmployeeTimingsSnapshot, d: number) => t.day_timings?.find((x) => x.day_of_week === d);
  const patch: NonNullable<TimingsChangeInput['day_timing_patch']> = [];
  for (let d = 0; d < 7; d++) {
    const a = dayOf(current, d);
    const b = dayOf(next, d);
    if (!same(a?.reporting_time, b?.reporting_time) || !same(a?.leaving_time, b?.leaving_time)) {
      patch.push({ day_of_week: d, reporting_time: b?.reporting_time ?? null, leaving_time: b?.leaving_time ?? null });
    }
  }
  if (patch.length) delta.day_timing_patch = patch;
  return delta;
}

/**
 * TAFSD-369: timing and working-day changes with an effective-from date.
 *
 * - Effective today or earlier: applied now. The progression timeline is
 *   split at the start of that day (PKT) and the new timings run forward
 *   from there; a back-dated change is refused when the timings changed
 *   again later, since that later change would otherwise be overwritten —
 *   unless override_later_changes is set (TAFSD-439), which writes only the
 *   changed fields through the later periods.
 * - Effective later: stored in employee_scheduled_timing_changes and applied
 *   on the day by applyDueScheduledChanges (daily, just after midnight PKT).
 *
 * progression valid_from = when it takes effect; recorded_at = when saved.
 */
@Injectable()
export class EmployeeTimingsService {
  private readonly logger = new Logger(EmployeeTimingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Build the full snapshot an input asks for, on top of the current one. Validates it. */
  mergeSnapshot(current: EmployeeTimingsSnapshot, input: TimingsChangeInput): EmployeeTimingsSnapshot {
    const next: EmployeeTimingsSnapshot = {
      ...current,
      day_timings: [...(current.day_timings ?? [])],
    };
    if (input.check_in_source !== undefined) next.check_in_source = input.check_in_source;
    if (input.reporting_time !== undefined) next.reporting_time = input.reporting_time ? input.reporting_time.slice(0, 5) : null;
    if (input.leaving_time !== undefined) next.leaving_time = input.leaving_time ? input.leaving_time.slice(0, 5) : null;
    if (input.late_relaxation_minutes !== undefined) next.late_relaxation_minutes = input.late_relaxation_minutes;
    if (input.days_per_week !== undefined) next.days_per_week = input.days_per_week;
    if (input.working_days !== undefined) {
      if (input.working_days === null) {
        next.working_days = null;
      } else {
        const days = [...new Set(input.working_days)].sort((a, b) => a - b);
        if (!days.length) throw new BadRequestException('Pick at least one working day.');
        if (days.some((d) => d < 0 || d > 6)) throw new BadRequestException('Working days must be 0 (Sunday) to 6 (Saturday).');
        // A standard pattern is carried by days_per_week alone, as the form does.
        const isDefault = JSON.stringify(days) === JSON.stringify(defaultPattern(days.length)) && days.length >= 5;
        next.working_days = isDefault ? null : days;
        next.days_per_week = days.length;
      }
    }
    if (input.day_timings !== undefined) {
      const seen = new Set<number>();
      next.day_timings = [];
      for (const d of input.day_timings) {
        if (d.day_of_week < 0 || d.day_of_week > 6) throw new BadRequestException('day_of_week must be 0–6.');
        if (seen.has(d.day_of_week)) throw new BadRequestException(`${WEEKDAY_SHORT[d.day_of_week]} is listed twice.`);
        seen.add(d.day_of_week);
        const rin = d.reporting_time ? d.reporting_time.slice(0, 5) : null;
        const rout = d.leaving_time ? d.leaving_time.slice(0, 5) : null;
        if (rin || rout) next.day_timings.push({ day_of_week: d.day_of_week, reporting_time: rin, leaving_time: rout });
      }
      next.day_timings.sort((a, b) => a.day_of_week - b.day_of_week);
    }
    if (input.day_timing_patch?.length) {
      for (const d of input.day_timing_patch) {
        if (d.day_of_week < 0 || d.day_of_week > 6) throw new BadRequestException('day_of_week must be 0–6.');
        const rin = d.reporting_time ? d.reporting_time.slice(0, 5) : null;
        const rout = d.leaving_time ? d.leaving_time.slice(0, 5) : null;
        next.day_timings = next.day_timings.filter((x) => x.day_of_week !== d.day_of_week);
        if (rin || rout) next.day_timings.push({ day_of_week: d.day_of_week, reporting_time: rin, leaving_time: rout });
      }
      next.day_timings.sort((a, b) => a.day_of_week - b.day_of_week);
    }

    if (next.check_in_source === CheckInSource.FIXED && (!next.reporting_time || !next.leaving_time)) {
      throw new BadRequestException('Reporting and leaving time are required for fixed timings.');
    }
    if (next.reporting_time && next.leaving_time && next.leaving_time <= next.reporting_time) {
      throw new BadRequestException('Leaving time must be after reporting time.');
    }
    for (const d of next.day_timings) {
      const rin = d.reporting_time ?? next.reporting_time;
      const rout = d.leaving_time ?? next.leaving_time;
      if (rin && rout && rout <= rin) {
        throw new BadRequestException(`${WEEKDAY_SHORT[d.day_of_week]}: leaving time must be after reporting time.`);
      }
    }
    if (next.late_relaxation_minutes != null && (next.late_relaxation_minutes < 0 || next.late_relaxation_minutes > 240)) {
      throw new BadRequestException('Late relaxation must be 0–240 minutes.');
    }
    return next;
  }

  async currentSnapshot(employeeId: number, db: Tx | PrismaService = this.prisma): Promise<EmployeeTimingsSnapshot> {
    const row = await db.employee_profiles.findUnique({ where: { id: employeeId }, include: PROFILE_TIMINGS_INCLUDE });
    if (!row) throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    return timingsSnapshotFrom(row);
  }

  async changeTimings(employeeId: number, input: TimingsChangeInput, changedBy: string): Promise<TimingsChangeResult> {
    const effective = input.effective_from ?? todayPkt();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) throw new BadRequestException('effective_from must be YYYY-MM-DD.');
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { full_name: true, campus_id: true },
    });
    if (!employee) throw new NotFoundException(`Employee with ID ${employeeId} not found`);

    const current = await this.currentSnapshot(employeeId);
    const next = this.mergeSnapshot(current, input);
    const change = describeTimingsChange(current, next);

    if (effective > todayPkt()) {
      if (!change) return { status: 'UNCHANGED', effective_from: effective, warnings: [] };
      await this.prisma.employee_scheduled_timing_changes.upsert({
        where: { employee_id_effective_from: { employee_id: employeeId, effective_from: new Date(`${effective}T00:00:00Z`) } },
        create: {
          employee_id: employeeId,
          effective_from: new Date(`${effective}T00:00:00Z`),
          timings: next as unknown as Prisma.InputJsonValue,
          changed_by: changedBy,
        },
        update: { timings: next as unknown as Prisma.InputJsonValue, changed_by: changedBy, recorded_at: new Date() },
      });
      this.auditLogs.log({
        entity_type: 'EMPLOYEE',
        entity_id: String(employeeId),
        action: 'UPDATED',
        section: 'hr',
        field: 'Timings (scheduled)',
        note: `${employee.full_name ?? `#${employeeId}`} — from ${formatDay(effective)}: ${change}`,
        changed_by: changedBy,
      });
      return { status: 'SCHEDULED', effective_from: effective, warnings: [] };
    }

    const { status } = await this.prisma.$transaction((tx) =>
      this.applyInTx(
        tx,
        employeeId,
        next,
        effective,
        changedBy,
        new Date(),
        input.notes ?? null,
        input.override_later_changes ? timingsDelta(current, next) : undefined,
      ),
    );
    if (status === 'UNCHANGED') return { status, effective_from: effective, warnings: [] };

    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'Timings',
      note: `${employee.full_name ?? `#${employeeId}`} — effective ${formatDay(effective)}: ${change}`,
      changed_by: changedBy,
    });
    return { status, effective_from: effective, warnings: await this.finalizedPayrollWarnings(employeeId, effective) };
  }

  /**
   * Apply `next` from the start of `effective` (PKT): profile fields, working
   * days and day timings take the new values, and the progression timeline
   * gets them from that day on.
   */
  async applyInTx(
    tx: Tx,
    employeeId: number,
    next: EmployeeTimingsSnapshot,
    effective: string,
    changedBy: string | null,
    recordedAt: Date,
    notes: string | null,
    /** TAFSD-439: set to override later changes; only these fields are carried through them. */
    overrideDelta?: TimingsChangeInput,
  ): Promise<{ status: 'APPLIED' | 'UNCHANGED' }> {
    const start = pktDayStart(effective);
    const periods = await tx.employee_progression_periods.findMany({
      where: { employee_id: employeeId },
      orderBy: { valid_from: 'asc' },
    });
    const nextKey = timingsKey(next);

    if (periods.length) {
      let idx = -1;
      periods.forEach((p, i) => {
        if (p.valid_from.getTime() <= start.getTime()) idx = i;
      });
      if (idx < 0) {
        throw new BadRequestException(
          `${formatDay(effective)} is before this employee's history starts (${periods[0].valid_from.toISOString().slice(0, 10)}).`,
        );
      }
      const covering = periods[idx];
      const coveringKey = timingsKey(covering.timings as unknown as EmployeeTimingsSnapshot);
      // Every later period must still carry the covering period's timings —
      // otherwise the timings changed again later, and this would erase it.
      const laterChange = periods
        .slice(idx + 1)
        .find((p) => timingsKey(p.timings as unknown as EmployeeTimingsSnapshot) !== coveringKey);
      if (laterChange && !overrideDelta) {
        throw new BadRequestException(
          `The timings were changed again with effect from ${laterChange.valid_from.toISOString().slice(0, 10)}. ` +
            `Make this change effective from that date or later, or apply it anyway to override the later change.`,
        );
      }
      if (laterChange && overrideDelta) {
        await this.overrideFrom(tx, periods, idx, start, overrideDelta, changedBy, recordedAt, notes);
        await this.writeProfile(tx, employeeId, next);
        return { status: 'APPLIED' };
      }
      if (coveringKey === nextKey) {
        // Same timings already in force from this day: only the profile may lag.
        await this.writeProfile(tx, employeeId, next);
        return { status: 'UNCHANGED' };
      }

      const prior = covering.timings as unknown as EmployeeTimingsSnapshot | null;
      const changeNote = (notes ?? (prior ? describeTimingsChange(prior, next) : null))?.slice(0, 255) ?? null;
      if (covering.valid_from.getTime() === start.getTime()) {
        // A period already starts that day (e.g. a second change the same
        // day): the last one saved wins.
        await tx.employee_progression_periods.update({
          where: { id: covering.id },
          data: {
            timings: next as unknown as Prisma.InputJsonValue,
            change_type: covering.change_type === 'ONBOARDED' ? covering.change_type : 'TIMING_CHANGED',
            changed_by: changedBy,
            notes: changeNote,
            recorded_at: recordedAt,
          },
        });
      } else {
        const { id: _id, valid_from: _vf, valid_to, recorded_at: _ra, change_type: _ct, changed_by: _cb, notes: _n, timings: _t, ...dims } = covering;
        await tx.employee_progression_periods.update({ where: { id: covering.id }, data: { valid_to: start } });
        await tx.employee_progression_periods.create({
          data: {
            ...dims,
            class_sections: (dims.class_sections ?? Prisma.DbNull) as Prisma.InputJsonValue,
            timings: next as unknown as Prisma.InputJsonValue,
            change_type: 'TIMING_CHANGED',
            changed_by: changedBy,
            notes: changeNote,
            valid_from: start,
            valid_to,
            recorded_at: recordedAt,
          },
        });
      }
      // The new timings run forward through the later periods.
      for (const p of periods.slice(idx + 1)) {
        await tx.employee_progression_periods.update({
          where: { id: p.id },
          data: { timings: next as unknown as Prisma.InputJsonValue },
        });
      }
    }

    await this.writeProfile(tx, employeeId, next);
    return { status: 'APPLIED' };
  }

  /**
   * TAFSD-439: write `delta` from `start` onward when the timings changed
   * again later. The covering period is split at `start` (or updated when it
   * starts that day) and every later period gets the same fields changed, so
   * each later change keeps whatever else it set.
   */
  private async overrideFrom(
    tx: Tx,
    periods: Awaited<ReturnType<Tx['employee_progression_periods']['findMany']>>,
    idx: number,
    start: Date,
    delta: TimingsChangeInput,
    changedBy: string | null,
    recordedAt: Date,
    notes: string | null,
  ) {
    const covering = periods[idx];
    const prior = covering.timings as unknown as EmployeeTimingsSnapshot;
    const fromStart = this.mergeSnapshot(prior, delta);
    const changeNote = (notes ?? describeTimingsChange(prior, fromStart))?.slice(0, 255) || null;
    if (covering.valid_from.getTime() === start.getTime()) {
      await tx.employee_progression_periods.update({
        where: { id: covering.id },
        data: {
          timings: fromStart as unknown as Prisma.InputJsonValue,
          change_type: covering.change_type === 'ONBOARDED' ? covering.change_type : 'TIMING_CHANGED',
          changed_by: changedBy,
          notes: changeNote,
          recorded_at: recordedAt,
        },
      });
    } else if (timingsKey(prior) !== timingsKey(fromStart)) {
      const { id: _id, valid_from: _vf, valid_to, recorded_at: _ra, change_type: _ct, changed_by: _cb, notes: _n, timings: _t, ...dims } = covering;
      await tx.employee_progression_periods.update({ where: { id: covering.id }, data: { valid_to: start } });
      await tx.employee_progression_periods.create({
        data: {
          ...dims,
          class_sections: (dims.class_sections ?? Prisma.DbNull) as Prisma.InputJsonValue,
          timings: fromStart as unknown as Prisma.InputJsonValue,
          change_type: 'TIMING_CHANGED',
          changed_by: changedBy,
          notes: changeNote,
          valid_from: start,
          valid_to,
          recorded_at: recordedAt,
        },
      });
    }
    for (const p of periods.slice(idx + 1)) {
      const t = p.timings as unknown as EmployeeTimingsSnapshot | null;
      if (!t) continue;
      await tx.employee_progression_periods.update({
        where: { id: p.id },
        data: { timings: this.mergeSnapshot(t, delta) as unknown as Prisma.InputJsonValue },
      });
    }
  }

  /** Profile fields, custom working days and day timings from a snapshot. */
  private async writeProfile(tx: Tx, employeeId: number, t: EmployeeTimingsSnapshot) {
    await tx.employee_profiles.update({
      where: { id: employeeId },
      data: {
        check_in_source: (t.check_in_source as CheckInSource) ?? CheckInSource.FIXED,
        reporting_time: t.reporting_time ? parseHhmm(t.reporting_time) : null,
        leaving_time: t.leaving_time ? parseHhmm(t.leaving_time) : null,
        late_relaxation_minutes: t.late_relaxation_minutes,
        days_per_week: t.days_per_week,
      },
    });
    await tx.employee_work_schedules.deleteMany({ where: { employee_id: employeeId } });
    if (t.working_days) {
      await tx.employee_work_schedules.createMany({
        data: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ employee_id: employeeId, day_of_week: d, is_working: t.working_days!.includes(d) })),
      });
    }
    await tx.employee_day_timings.deleteMany({ where: { employee_id: employeeId } });
    if (t.day_timings?.length) {
      await tx.employee_day_timings.createMany({
        data: t.day_timings.map((d) => ({
          employee_id: employeeId,
          day_of_week: d.day_of_week,
          reporting_time: d.reporting_time ? parseHhmm(d.reporting_time) : null,
          leaving_time: d.leaving_time ? parseHhmm(d.leaving_time) : null,
        })),
      });
    }
  }

  /** A finalized payroll that already covers the effective date needs its line regenerated. */
  private async finalizedPayrollWarnings(employeeId: number, effective: string): Promise<string[]> {
    const lines = await this.prisma.payroll_run_lines.findMany({
      where: {
        employee_id: employeeId,
        payroll_runs: { status: 'FINALIZED', period_end: { gte: new Date(`${effective}T00:00:00Z`) } },
      },
      select: { payroll_runs: { select: { period_start: true, period_end: true } } },
    });
    return lines.map(
      (l) =>
        `The ${l.payroll_runs.period_start.toISOString().slice(0, 10)} → ${l.payroll_runs.period_end.toISOString().slice(0, 10)} payroll is finalized and already covers this date; regenerate this employee's line to apply it.`,
    );
  }

  /** One weekday's timings (bulk Day timings window); both null puts it back to normal. */
  async setOneDay(
    employeeId: number,
    day: { day_of_week: number; reporting_time: string | null; leaving_time: string | null },
    effective: string | undefined,
    changedBy: string,
    overrideLaterChanges = false,
  ): Promise<TimingsChangeResult> {
    const current = await this.currentSnapshot(employeeId);
    const others = (current.day_timings ?? []).filter((d) => d.day_of_week !== day.day_of_week);
    return this.changeTimings(
      employeeId,
      {
        effective_from: effective,
        day_timings: day.reporting_time || day.leaving_time ? [...others, day] : others,
        override_later_changes: overrideLaterChanges,
      },
      changedBy,
    );
  }

  async listScheduled(employeeId: number) {
    const rows = await this.prisma.employee_scheduled_timing_changes.findMany({
      where: { employee_id: employeeId },
      orderBy: { effective_from: 'asc' },
    });
    const current = await this.currentSnapshot(employeeId);
    return rows.map((r) => ({
      id: r.id,
      effective_from: r.effective_from.toISOString().slice(0, 10),
      timings: r.timings,
      changed_by: r.changed_by,
      recorded_at: r.recorded_at,
      summary: describeTimingsChange(current, r.timings as unknown as EmployeeTimingsSnapshot),
    }));
  }

  async cancelScheduled(employeeId: number, id: number, changedBy: string) {
    const row = await this.prisma.employee_scheduled_timing_changes.findFirst({ where: { id, employee_id: employeeId } });
    if (!row) throw new NotFoundException('Scheduled change not found');
    await this.prisma.employee_scheduled_timing_changes.delete({ where: { id } });
    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'Timings (scheduled)',
      note: `Cancelled the timings change scheduled from ${formatDay(row.effective_from.toISOString().slice(0, 10))}`,
      changed_by: changedBy,
    });
    return { cancelled: true };
  }

  /** Apply every scheduled change whose day has come, oldest first. */
  @Cron('5 0 * * *', { name: 'apply-scheduled-timing-changes', timeZone: 'Asia/Karachi' })
  async applyDueScheduledChanges(): Promise<{ applied: number; failed: number }> {
    const due = await this.prisma.employee_scheduled_timing_changes.findMany({
      where: { effective_from: { lte: new Date(`${todayPkt()}T00:00:00Z`) } },
      orderBy: { effective_from: 'asc' },
    });
    let applied = 0;
    let failed = 0;
    for (const row of due) {
      const effective = row.effective_from.toISOString().slice(0, 10);
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.applyInTx(
            tx,
            row.employee_id,
            row.timings as unknown as EmployeeTimingsSnapshot,
            effective,
            row.changed_by,
            row.recorded_at,
            null,
          );
          await tx.employee_scheduled_timing_changes.delete({ where: { id: row.id } });
        });
        applied++;
      } catch (err) {
        failed++;
        this.logger.warn(`Scheduled timing change ${row.id} (employee ${row.employee_id}, ${effective}) not applied: ${(err as Error).message}`);
      }
    }
    if (due.length) this.logger.log(`Scheduled timing changes: ${applied} applied, ${failed} failed`);
    return { applied, failed };
  }
}
