import { EmployeeExpectedTimesService } from '../../timetables/employee-expected-times.service';
import { EmployeeProgressionService } from './employee-progression.service';
import { hhmm, parseHhmm, timingsForDate, timingsKey, timingsSnapshotFrom } from './employee-day-timings.util';

// TAFSD-363: per-weekday staff timings (Friday) and timings on the progression timeline.

const t = (s: string) => parseHhmm(s);
const FRI = new Date(Date.UTC(2026, 9, 16)); // Friday
const THU = new Date(Date.UTC(2026, 9, 15));
const base = { reporting_time: t('07:30'), leaving_time: t('14:20') };

describe('timingsForDate', () => {
  it('uses the weekday row on its day, and the normal times on other days', () => {
    const rows = [{ day_of_week: 5, reporting_time: null, leaving_time: t('12:00') }];
    expect(hhmm(timingsForDate(base, rows, FRI).leaving_time)).toBe('12:00');
    expect(hhmm(timingsForDate(base, rows, FRI).reporting_time)).toBe('07:30'); // null side falls back
    expect(timingsForDate(base, rows, FRI).dayOverride).toBe(true);
    expect(hhmm(timingsForDate(base, rows, THU).leaving_time)).toBe('14:20');
    expect(timingsForDate(base, rows, THU).dayOverride).toBe(false);
  });
});

describe('EmployeeExpectedTimesService with day timings', () => {
  function build(dayRows: unknown[]) {
    const prisma = {
      employee_profiles: {
        findUnique: jest.fn(async () => ({
          check_in_source: 'FIXED',
          ...base,
          late_relaxation_minutes: 5,
          campus_id: 1,
          employee_day_timings: dayRows,
        })),
      },
      employee_shift_overrides: { findUnique: jest.fn(async () => null) },
      hr_policy_sets: { findMany: jest.fn(async () => []) },
    };
    return new EmployeeExpectedTimesService(prisma as any, {} as any);
  }

  it('Friday is judged against Friday hours', async () => {
    const svc = build([{ day_of_week: 5, reporting_time: t('08:00'), leaving_time: t('12:00') }]);
    const fri = await svc.resolveExpectedTimes(9, 1, FRI);
    expect([hhmm(fri.expectedCheckIn), hhmm(fri.expectedCheckOut), fri.source]).toEqual(['08:00', '12:00', 'FIXED']);
    const thu = await svc.resolveExpectedTimes(9, 1, THU);
    expect([hhmm(thu.expectedCheckIn), hhmm(thu.expectedCheckOut)]).toEqual(['07:30', '14:20']);
  });
});

describe('progression timings', () => {
  const snap = (over: Record<string, unknown> = {}) => ({
    campusId: 1, segmentId: null, departmentId: 1, staffCategoryId: 1, reportingManagerId: null,
    jobTitle: 'TEACHER', employmentType: null, employmentStatus: 'ACTIVE', monthlyPay: '40000',
    payrollEnabled: true, classSections: [],
    timings: timingsSnapshotFrom({ check_in_source: 'FIXED', ...base, late_relaxation_minutes: 5, days_per_week: 6 }),
    ...over,
  });
  const svc = new EmployeeProgressionService();

  it('labels a timings-only change TIMING_CHANGED', () => {
    const next = snap({ timings: { ...snap().timings, reporting_time: '07:00' } });
    expect(svc.resolveChangeType({ prior: snap() as any, next: next as any, defaultType: 'REASSIGNED' })).toBe('TIMING_CHANGED');
  });

  it('a Friday-only change is a timing change too', () => {
    const next = snap({ timings: { ...snap().timings, day_timings: [{ day_of_week: 5, reporting_time: null, leaving_time: '12:00' }] } });
    expect(timingsKey(next.timings)).not.toBe(timingsKey(snap().timings));
    expect(svc.resolveChangeType({ prior: snap() as any, next: next as any, defaultType: 'X' })).toBe('TIMING_CHANGED');
  });

  function tx(open: Record<string, unknown> | null) {
    return {
      employee_progression_periods: {
        findFirst: jest.fn(async () => open),
        update: jest.fn(async () => ({})),
        create: jest.fn(async () => ({})),
      },
    };
  }
  const openRow = (timings: unknown) => ({
    id: 5, campus_id: 1, segment_id: null, department_id: 1, staff_category_id: 1, reporting_manager_id: null,
    job_title: 'TEACHER', employment_type: null, employment_status: 'ACTIVE', monthly_pay: '40000',
    payroll_enabled: true, class_sections: [], timings,
  });

  it('a period recorded before timings were tracked is filled in, not split', async () => {
    const db = tx(openRow(null));
    await svc.recordProgressionChange(db as any, { employeeId: 9, ...(snap() as any), changeType: 'REASSIGNED', changedBy: 'x' });
    expect(db.employee_progression_periods.create).not.toHaveBeenCalled();
    expect(db.employee_progression_periods.update.mock.calls[0][0]).toMatchObject({ where: { id: 5 }, data: { timings: snap().timings } });
  });

  it('a real timing change opens a new period carrying the new timings', async () => {
    const db = tx(openRow(snap().timings));
    const next = snap({ timings: { ...snap().timings, leaving_time: '16:30' } });
    await svc.recordProgressionChange(db as any, { employeeId: 9, ...(next as any), changeType: 'TIMING_CHANGED', changedBy: 'x' });
    expect(db.employee_progression_periods.create.mock.calls[0][0].data).toMatchObject({
      change_type: 'TIMING_CHANGED',
      timings: next.timings,
    });
  });

  it('callers that pass no timings carry the open period\'s forward', async () => {
    const db = tx(openRow(snap().timings));
    const { timings: _t, ...noTimings } = snap({ monthlyPay: '45000' }) as any;
    await svc.recordProgressionChange(db as any, { employeeId: 9, ...noTimings, changeType: 'PAY_CHANGED', changedBy: 'x' });
    expect(db.employee_progression_periods.create.mock.calls[0][0].data.timings).toEqual(snap().timings);
  });
});
