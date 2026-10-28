import { Prisma } from '@prisma/client';
import { PayrollService } from './payroll.service';

// TAFSD-437: "always full pay" on the profile — no attendance deductions in
// any cycle, but off-roster days and statutory items still count.

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
const at = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00Z`);

function build(workingDays: Set<string>) {
  const svc = Object.create(PayrollService.prototype) as any;
  svc.expectedTimes = {
    resolveExpectedTimes: jest.fn(async () => ({ expectedCheckIn: T('08:00'), expectedCheckOut: T('16:00'), graceMinutes: 0 })),
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

const base = {
  id: 9, monthly_pay: new Prisma.Decimal(31000), reporting_time: null, leaving_time: null, late_relaxation_minutes: null,
  department_id: 1, staff_category_id: 1, staff_categories: { code: 'T' }, days_per_week: 5, employee_work_schedules: [],
  check_in_source: 'FIXED', join_date: D('2020-01-01'), date_of_leaving: null,
};

const scan = (iso: string, hhmm: string) => ({ employee_id: 9, attendance_date: D(iso), scan_time: at(iso, hhmm), device_sn: 'X' });

function days(start: string, end: string) {
  const out: string[] = [];
  for (let d = D(start); d <= D(end); d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

// October: 3rd absent, 7th left 45 min early; every other day a full punch pair.
const range = days('2026-10-01', '2026-10-31');
const scans = range.flatMap((d) => {
  if (d === '2026-10-03') return [];
  return [scan(d, '08:00'), scan(d, d === '2026-10-07' ? '15:15' : '16:00')];
});

const line = (employee: object) =>
  build(new Set(range)).computeEmployeeLine(employee, 1, D('2026-10-01'), D('2026-10-31'), [], [], scans, true);

describe('always full pay', () => {
  it('without it, absence and early leave are deducted', async () => {
    const l = await line(base);
    expect(Number(l.absence_deduction)).toBeCloseTo(1000, 2);
    expect(Number(l.early_leave_deduction)).toBeCloseTo((1000 / 480) * 45, 2);
    expect(l.always_full_pay).toBe(false);
  });

  it('with it, every attendance deduction is zero and the line records why', async () => {
    const l = await line({ ...base, always_full_pay: true });
    expect(Number(l.absence_deduction)).toBe(0);
    expect(Number(l.half_day_deduction)).toBe(0);
    expect(Number(l.late_deduction)).toBe(0);
    expect(Number(l.early_leave_deduction)).toBe(0);
    expect(Number(l.break_deduction)).toBe(0);
    expect(Number(l.net_pay)).toBeCloseTo(31000, 2);
    expect(l).toMatchObject({ always_full_pay: true, full_pay_override: false });
    // The day facts stay visible; only the money is waived.
    expect(l.daily_breakdown.find((d: any) => d.date === '2026-10-03').classification).toBe('ABSENT');
  });

  it('still prorates days before a mid-cycle join', async () => {
    const l = await line({ ...base, always_full_pay: true, join_date: D('2026-10-11') });
    expect(Number(l.after_leaving_deduction)).toBeCloseTo(10000, 2);
    expect(Number(l.net_pay)).toBeCloseTo(21000, 2);
  });

  it('raises no sandwich or late flags', () => {
    const svc = Object.create(PayrollService.prototype) as any;
    svc.detectPayrollFlags = jest.fn(() => [{ flag_type: 'SANDWICH' }]);
    expect(svc.detectFlagsForLine({ full_pay_override: false, always_full_pay: true, daily_breakdown: [] })).toEqual([]);
    expect(svc.detectFlagsForLine({ full_pay_override: false, always_full_pay: false, daily_breakdown: [] })).toHaveLength(1);
  });
});
