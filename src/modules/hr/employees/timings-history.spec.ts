import { EmployeeExpectedTimesService } from '../../timetables/employee-expected-times.service';
import { hhmm } from './employee-day-timings.util';
import { coveringPeriodIndex, scheduleFromSnapshot, timingsOnDate } from './timings-history.util';

// TAFSD-277: a day is judged by the timings in effect on it, not today's.

const snap = (over: Record<string, unknown> = {}) => ({
  check_in_source: 'FIXED',
  reporting_time: '07:30',
  leaving_time: '14:20',
  late_relaxation_minutes: 5,
  days_per_week: 5,
  working_days: null,
  day_timings: [],
  ...over,
});
// Ume Farwa's real history: 13 Oct 02:20 UTC (07:20 PKT) and 16 Oct 17:57 UTC (22:57 PKT).
const periods = [
  { valid_from: new Date('2026-07-26T00:00:00Z'), timings: snap() },
  { valid_from: new Date('2026-10-13T02:20:09Z'), timings: snap({ leaving_time: '16:30', late_relaxation_minutes: 6, days_per_week: 6 }) },
  { valid_from: new Date('2026-10-16T17:57:17Z'), timings: snap({ reporting_time: '07:00', leaving_time: '16:30', late_relaxation_minutes: 6, days_per_week: 6 }) },
];
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('timingsOnDate', () => {
  it('picks the period in effect on each day; a change counts from the PKT day it was made', () => {
    expect(timingsOnDate(periods as any, day('2026-10-12'))?.leaving_time).toBe('14:20');
    expect(timingsOnDate(periods as any, day('2026-10-13'))?.leaving_time).toBe('16:30');
    expect(timingsOnDate(periods as any, day('2026-10-15'))?.reporting_time).toBe('07:30');
    expect(timingsOnDate(periods as any, day('2026-10-16'))?.reporting_time).toBe('07:00');
  });

  it('nothing recorded before the first period: fall back to current values', () => {
    expect(timingsOnDate(periods as any, day('2026-07-01'))).toBeNull();
    expect(coveringPeriodIndex(periods as any, day('2026-07-01'))).toBe(-1);
  });

  it('rebuilds the working-day pattern', () => {
    expect(scheduleFromSnapshot(snap({ working_days: [1, 2, 3, 4, 6] }) as any).employee_work_schedules.find((r) => r.day_of_week === 5)?.is_working).toBe(false);
    expect(scheduleFromSnapshot(snap() as any)).toMatchObject({ days_per_week: 5, employee_work_schedules: [] });
  });
});

describe('EmployeeExpectedTimesService uses the history', () => {
  it('a day before a change gets the old times; after it, the new ones', async () => {
    const prisma = {
      employee_profiles: {
        findUnique: jest.fn(async () => ({
          check_in_source: 'FIXED',
          reporting_time: new Date(Date.UTC(1970, 0, 1, 7, 0)),
          leaving_time: new Date(Date.UTC(1970, 0, 1, 16, 30)),
          late_relaxation_minutes: 6,
          campus_id: 2,
          employee_day_timings: [],
          employee_progression_periods: periods,
        })),
      },
      employee_shift_overrides: { findUnique: jest.fn(async () => null) },
      hr_policy_sets: { findMany: jest.fn(async () => []) },
    };
    const svc = new EmployeeExpectedTimesService(prisma as any, {} as any);
    const before = await svc.resolveExpectedTimes(91, 2, day('2026-10-08'));
    expect([hhmm(before.expectedCheckIn), hhmm(before.expectedCheckOut), before.graceMinutes]).toEqual(['07:30', '14:20', 5]);
    const after = await svc.resolveExpectedTimes(91, 2, day('2026-10-20'));
    expect([hhmm(after.expectedCheckIn), hhmm(after.expectedCheckOut), after.graceMinutes]).toEqual(['07:00', '16:30', 6]);
  });
});
