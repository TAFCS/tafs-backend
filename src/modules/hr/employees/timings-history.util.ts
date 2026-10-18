/**
 * TAFSD-277: the timings an employee had on a given date.
 *
 * Every employee_progression_periods row carries the timings in effect while
 * it was open (TAFSD-363). Attendance recompute and payroll judge each day by
 * the period that covers it, so a mid-cycle change (new hours, an extra
 * working day, timetable → fixed) only affects the days after it.
 *
 * A change counts from the calendar day (Pakistan time) it was made on: the
 * covering period is the last one that started on or before the end of that
 * day. Dates are DATE values, i.e. UTC midnight of the PKT calendar day.
 */
import { Prisma } from '@prisma/client';
import { parseHhmm, type DayTimingRow, type EmployeeTimingsSnapshot } from './employee-day-timings.util';

export type PeriodTimingsRow = { valid_from: Date; timings: Prisma.JsonValue | null };

/** End of the PKT calendar day `date` (UTC midnight), as an instant: date + 24h - 5h. */
const PKT_DAY_END_OFFSET_MS = 19 * 60 * 60 * 1000;

/** Index of the period covering `date` in `periods`, or -1 when none started by then. */
export function coveringPeriodIndex(periods: PeriodTimingsRow[], date: Date): number {
  const cutoff = date.getTime() + PKT_DAY_END_OFFSET_MS;
  let found = -1;
  periods.forEach((p, i) => {
    if (p.valid_from.getTime() < cutoff && (found < 0 || p.valid_from.getTime() >= periods[found].valid_from.getTime())) found = i;
  });
  return found;
}

/** The timings snapshot covering `date`, or null when none is recorded (use the current values). */
export function timingsOnDate(periods: PeriodTimingsRow[], date: Date): EmployeeTimingsSnapshot | null {
  const i = coveringPeriodIndex(periods, date);
  return i < 0 ? null : ((periods[i].timings as unknown as EmployeeTimingsSnapshot | null) ?? null);
}

/** The working-day inputs resolveStaffDay* take, from a snapshot. */
export function scheduleFromSnapshot(t: EmployeeTimingsSnapshot): {
  days_per_week: number | null;
  employee_work_schedules: { day_of_week: number; is_working: boolean }[];
  check_in_source: string | null;
} {
  return {
    days_per_week: t.days_per_week ?? null,
    // A custom pattern is stored as the list of worked days; rebuild all seven rows.
    employee_work_schedules: t.working_days
      ? [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, is_working: t.working_days!.includes(d) }))
      : [],
    check_in_source: t.check_in_source ?? null,
  };
}

/** The timing fields EmployeeExpectedTimesService reads, from a snapshot. */
export function timingFieldsFromSnapshot(t: EmployeeTimingsSnapshot): {
  check_in_source: string | null;
  reporting_time: Date | null;
  leaving_time: Date | null;
  late_relaxation_minutes: number | null;
  employee_day_timings: DayTimingRow[];
} {
  return {
    check_in_source: t.check_in_source ?? null,
    reporting_time: t.reporting_time ? parseHhmm(t.reporting_time) : null,
    leaving_time: t.leaving_time ? parseHhmm(t.leaving_time) : null,
    late_relaxation_minutes: t.late_relaxation_minutes ?? null,
    employee_day_timings: (t.day_timings ?? []).map((d) => ({
      day_of_week: d.day_of_week,
      reporting_time: d.reporting_time ? parseHhmm(d.reporting_time) : null,
      leaving_time: d.leaving_time ? parseHhmm(d.leaving_time) : null,
    })),
  };
}

/** Same Prisma select everywhere the history is loaded. */
export const PERIOD_TIMINGS_SELECT = { valid_from: true, timings: true } as const;
