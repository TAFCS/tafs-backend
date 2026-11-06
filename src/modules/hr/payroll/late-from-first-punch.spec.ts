import { AttendanceSource, Prisma } from '@prisma/client';
import { PayrollService } from './payroll.service';

// TAFSD-485: a punched day is late when its first punch is after reporting time
// plus grace, whatever the stored status says. A stale PRESENT used to hide the
// late arrival while the early leave on the same day was still deducted.

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
const at = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00Z`);

function build(workingDays: Set<string>, grace = 0) {
  const svc = Object.create(PayrollService.prototype) as any;
  svc.expectedTimes = {
    resolveExpectedTimes: jest.fn(async () => ({ expectedCheckIn: T('08:00'), expectedCheckOut: T('16:00'), graceMinutes: grace })),
  };
  svc.calendarResolver = {
    resolveStaffDayFromRows: (_rows: unknown, d: Date) =>
      workingDays.has(d.toISOString().slice(0, 10))
        ? { isWorkingDay: true, dayType: null, description: null, source: 'SCHEDULE' }
        : { isWorkingDay: false, dayType: 'WEEKEND', description: 'Weekend', source: 'SCHEDULE' },
  };
  svc.payrollRules = { findEffective: jest.fn(async () => null) };
  return svc;
}

const employee = {
  id: 9, monthly_pay: new Prisma.Decimal(31000), reporting_time: null, leaving_time: null, late_relaxation_minutes: null,
  department_id: 1, staff_category_id: 1, staff_categories: { code: 'T' }, days_per_week: 5, employee_work_schedules: [],
  check_in_source: 'FIXED', join_date: D('2020-01-01'), date_of_leaving: null,
};

const scan = (iso: string, hhmm: string) => ({
  employee_id: 9, attendance_date: D(iso), scan_time: at(iso, hhmm), device_sn: 'X',
});
const range = ['2026-10-05', '2026-10-06', '2026-10-07'];
const START = D('2026-10-05');
const END = D('2026-10-07');

/** 08:00–16:00 every day, except 6 Oct: in at 08:40, out at 15:30. */
const scans = range.flatMap((d) =>
  d === '2026-10-06' ? [scan(d, '08:40'), scan(d, '15:30')] : [scan(d, '08:00'), scan(d, '16:00')],
);
const stored = (status: string, source: AttendanceSource = AttendanceSource.BIOMETRIC) => ({
  employee_id: 9, date: D('2026-10-06'), status, source,
  check_in_at: at('2026-10-06', '08:40'), check_out_at: at('2026-10-06', '15:30'),
  marked_by: null, updated_at: new Date(),
});
const day6 = (l: any) => l.daily_breakdown.find((d: any) => d.date === '2026-10-06');

describe('TAFSD-485: late arrival is judged from the first punch', () => {
  const perMinute = 1000 / 480;

  it('deducts both the late arrival and the early leave when the stored status says PRESENT', async () => {
    const l = await build(new Set(range)).computeEmployeeLine(employee, 1, START, END, [], [stored('PRESENT')], scans, true);
    expect(day6(l).classification).toBe('LATE');
    expect(day6(l).late_minutes).toBe(40);
    expect(day6(l).early_leave_minutes).toBe(30);
    expect(Number(l.late_deduction)).toBeCloseTo(40 * perMinute, 2);
    expect(Number(l.early_leave_deduction)).toBeCloseTo(30 * perMinute, 2);
  });

  it('does the same when the day has no stored row yet', async () => {
    const l = await build(new Set(range)).computeEmployeeLine(employee, 1, START, END, [], [], scans, true);
    expect(day6(l).late_minutes).toBe(40);
  });

  it('a first punch inside the grace window is not late', async () => {
    const l = await build(new Set(range), 45).computeEmployeeLine(employee, 1, START, END, [], [stored('PRESENT')], scans, true);
    expect(day6(l).classification).toBe('PRESENT');
    expect(day6(l).late_minutes).toBe(0);
  });

  it('leaves a manual PRESENT alone: HR forgave the lateness', async () => {
    const l = await build(new Set(range)).computeEmployeeLine(
      employee, 1, START, END, [], [stored('PRESENT', AttendanceSource.MANUAL)], scans, true,
    );
    expect(day6(l).classification).toBe('PRESENT');
    expect(day6(l).late_minutes).toBe(0);
  });
});
