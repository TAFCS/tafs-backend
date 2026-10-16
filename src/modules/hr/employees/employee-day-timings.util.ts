/**
 * TAFSD-363: per-weekday staff timings.
 *
 * An employee has normal timings (reporting_time / leaving_time) and may have
 * a row per weekday in employee_day_timings that differs from them — Friday,
 * at TAFS. Each side of a row falls back to the normal time when null, so a
 * row can change only the leaving time. Every reader that needs "the times
 * this employee was expected on this date" goes through timingsForDate.
 */

export type DayTimingRow = {
  day_of_week: number;
  reporting_time: Date | null;
  leaving_time: Date | null;
};

export type BaseTimings = {
  reporting_time: Date | null;
  leaving_time: Date | null;
};

/** The reporting / leaving time that applies on a given weekday (0 = Sunday). */
export function timingsForDay(
  base: BaseTimings,
  rows: DayTimingRow[] | null | undefined,
  dayOfWeek: number,
): BaseTimings & { dayOverride: boolean } {
  const row = rows?.find((r) => r.day_of_week === dayOfWeek);
  if (!row || (row.reporting_time == null && row.leaving_time == null)) {
    return { ...base, dayOverride: false };
  }
  return {
    reporting_time: row.reporting_time ?? base.reporting_time,
    leaving_time: row.leaving_time ?? base.leaving_time,
    dayOverride: true,
  };
}

/** Same as timingsForDay, for a calendar date stored as UTC midnight (DATE columns). */
export function timingsForDate(base: BaseTimings, rows: DayTimingRow[] | null | undefined, date: Date) {
  return timingsForDay(base, rows, date.getUTCDay());
}

/** "07:30" from a TIME(0) value (stored on 1970-01-01 UTC), or null. */
export function hhmm(value: Date | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** A TIME(0) value from "HH:MM" or "HH:MM:SS". */
export function parseHhmm(value: string): Date {
  const [h, m] = value.split(':').map((p) => parseInt(p, 10));
  return new Date(Date.UTC(1970, 0, 1, h, m || 0, 0));
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The timings tracked on a progression period (employee_progression_periods.timings). */
export type EmployeeTimingsSnapshot = {
  check_in_source: string | null;
  reporting_time: string | null;
  leaving_time: string | null;
  late_relaxation_minutes: number | null;
  days_per_week: number | null;
  /** Custom working days (0 = Sunday), or null when the default for days_per_week applies. */
  working_days: number[] | null;
  /** Weekdays with their own timings. */
  day_timings: { day_of_week: number; reporting_time: string | null; leaving_time: string | null }[];
};

/** Snapshot of an employee_profiles row with employee_work_schedules and employee_day_timings loaded. */
export function timingsSnapshotFrom(row: {
  check_in_source?: string | null;
  reporting_time?: Date | null;
  leaving_time?: Date | null;
  late_relaxation_minutes?: number | null;
  days_per_week?: number | null;
  employee_work_schedules?: { day_of_week: number; is_working: boolean }[] | null;
  employee_day_timings?: DayTimingRow[] | null;
}): EmployeeTimingsSnapshot {
  const schedules = row.employee_work_schedules ?? [];
  return {
    check_in_source: row.check_in_source ?? null,
    reporting_time: hhmm(row.reporting_time),
    leaving_time: hhmm(row.leaving_time),
    late_relaxation_minutes: row.late_relaxation_minutes ?? null,
    days_per_week: row.days_per_week ?? null,
    working_days: schedules.length
      ? schedules.filter((s) => s.is_working).map((s) => s.day_of_week).sort((a, b) => a - b)
      : null,
    day_timings: (row.employee_day_timings ?? [])
      .filter((d) => d.reporting_time != null || d.leaving_time != null)
      .map((d) => ({ day_of_week: d.day_of_week, reporting_time: hhmm(d.reporting_time), leaving_time: hhmm(d.leaving_time) }))
      .sort((a, b) => a.day_of_week - b.day_of_week),
  };
}

/** Order-stable string form, for comparing two snapshots. */
export function timingsKey(t: EmployeeTimingsSnapshot | null | undefined): string {
  if (!t) return '';
  return JSON.stringify([
    t.check_in_source ?? null,
    t.reporting_time ?? null,
    t.leaving_time ?? null,
    t.late_relaxation_minutes ?? null,
    t.days_per_week ?? null,
    t.working_days ?? null,
    (t.day_timings ?? []).map((d) => [d.day_of_week, d.reporting_time, d.leaving_time]),
  ]);
}
