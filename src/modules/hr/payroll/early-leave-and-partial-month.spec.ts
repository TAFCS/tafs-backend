import { AttendanceSource, Prisma } from '@prisma/client';
import { PayrollService } from './payroll.service';
import { partialMonthDivisor } from './payroll-period.util';

// TAFSD-434: leaving before the expected leaving time is deducted per minute,
// and a range shorter than a pay month earns only its share of the salary.

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
const at = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00Z`);

function build(workingDays: Set<string>, shift = { in: '08:00', out: '16:00' }) {
  const svc = Object.create(PayrollService.prototype) as any;
  svc.expectedTimes = {
    resolveExpectedTimes: jest.fn(async () => ({ expectedCheckIn: T(shift.in), expectedCheckOut: T(shift.out), graceMinutes: 0 })),
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

function days(start: string, end: string) {
  const out: string[] = [];
  for (let d = D(start); d <= D(end); d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

/** Every day in the range is a working day with a full 08:00–16:00 punch pair, except where overridden. */
function fullAttendance(start: string, end: string, overrides: Record<string, string> = {}) {
  return days(start, end).flatMap((d) => [scan(d, '08:00'), scan(d, overrides[d] ?? '16:00')]);
}

describe('partialMonthDivisor', () => {
  it('treats a calendar month and the 26th -> 25th cycle as a whole pay month', () => {
    expect(partialMonthDivisor(D('2026-10-01'), D('2026-10-31'))).toBeNull();
    expect(partialMonthDivisor(D('2026-02-01'), D('2026-02-28'))).toBeNull();
    expect(partialMonthDivisor(D('2026-10-26'), D('2026-11-25'))).toBeNull();
    expect(partialMonthDivisor(D('2026-12-26'), D('2027-01-25'))).toBeNull();
  });

  it('prorates any other range by the days in its starting month', () => {
    expect(partialMonthDivisor(D('2026-10-01'), D('2026-10-08'))).toBe(31);
    expect(partialMonthDivisor(D('2026-10-01'), D('2026-10-30'))).toBe(31);
    expect(partialMonthDivisor(D('2026-11-20'), D('2026-12-05'))).toBe(30);
  });
});

describe('payroll: partial-month ranges earn their share of the salary', () => {
  it('an 8-day range pays 8 days, not the whole month', async () => {
    const range = days('2026-10-01', '2026-10-08');
    const svc = build(new Set(range));
    const l = await svc.computeEmployeeLine(employee, 1, D('2026-10-01'), D('2026-10-08'), [], [], fullAttendance('2026-10-01', '2026-10-08'), true);
    expect(Number(l.daily_rate)).toBeCloseTo(31000 / 31, 2);
    expect(Number(l.monthly_pay)).toBeCloseTo(8000, 2);
    expect(Number(l.net_pay)).toBeCloseTo(8000, 2);
  });

  it('an absence in a short range costs one day at the month rate', async () => {
    const range = days('2026-10-01', '2026-10-08');
    const svc = build(new Set(range));
    const scans = fullAttendance('2026-10-01', '2026-10-08').filter((s) => s.attendance_date.getTime() !== D('2026-10-05').getTime());
    const l = await svc.computeEmployeeLine(employee, 1, D('2026-10-01'), D('2026-10-08'), [], [], scans, true);
    expect(Number(l.absence_deduction)).toBeCloseTo(1000, 2);
    expect(Number(l.net_pay)).toBeCloseTo(7000, 2);
  });

  it('a whole calendar month still pays the full salary', async () => {
    const svc = build(new Set(days('2026-10-01', '2026-10-31')));
    const l = await svc.computeEmployeeLine(employee, 1, D('2026-10-01'), D('2026-10-31'), [], [], fullAttendance('2026-10-01', '2026-10-31'), true);
    expect(Number(l.monthly_pay)).toBe(31000);
  });
});

describe('payroll: leaving early is deducted per minute', () => {
  // 8h day = 480 min; daily rate 1,000 → 1,000 / 480 per minute.
  const perMinute = 1000 / 480;

  it('deducts the minutes between the last punch and the leaving time', async () => {
    const svc = build(new Set(days('2026-10-01', '2026-10-08')));
    const scans = fullAttendance('2026-10-01', '2026-10-08', { '2026-10-06': '14:30' });
    const l = await svc.computeEmployeeLine(employee, 1, D('2026-10-01'), D('2026-10-08'), [], [], scans, true);
    expect(l.total_early_leave_minutes).toBe(90);
    expect(Number(l.early_leave_deduction)).toBeCloseTo(90 * perMinute, 2);
    expect(Number(l.net_pay)).toBeCloseTo(8000 - 90 * perMinute, 2);
    expect(l.daily_breakdown.find((d: any) => d.date === '2026-10-06').early_leave_minutes).toBe(90);
  });

  it('deducts an early check-out entered on a manual override', async () => {
    const svc = build(new Set(days('2026-10-01', '2026-10-08')));
    const record = {
      employee_id: 9, date: D('2026-10-06'), status: 'PRESENT', source: AttendanceSource.MANUAL,
      check_in_at: at('2026-10-06', '08:00'), check_out_at: at('2026-10-06', '12:00'),
      marked_by: 'u1', updated_at: new Date(),
    };
    const l = await svc.computeEmployeeLine(employee, 1, D('2026-10-01'), D('2026-10-08'), [], [record], fullAttendance('2026-10-01', '2026-10-08'), true);
    expect(l.total_early_leave_minutes).toBe(240);
    expect(Number(l.early_leave_deduction)).toBeCloseTo(240 * perMinute, 2);
  });

  it('does not deduct when a shift override moved check-out earlier (approved early leave)', async () => {
    const svc = build(new Set(days('2026-10-01', '2026-10-08')));
    const scans = fullAttendance('2026-10-01', '2026-10-08', { '2026-10-06': '14:30' });
    const overrides = new Map([['2026-10-06', { start: null, end: T('14:30') }]]);
    const l = await svc.computeEmployeeLine(employee, 1, D('2026-10-01'), D('2026-10-08'), [], [], scans, true, undefined, overrides);
    expect(l.total_early_leave_minutes).toBe(0);
    expect(Number(l.early_leave_deduction)).toBe(0);
  });

  it('is waived by "pay full salary"', async () => {
    const svc = build(new Set(days('2026-10-01', '2026-10-08')));
    const scans = fullAttendance('2026-10-01', '2026-10-08', { '2026-10-06': '14:30' });
    const l = await svc.computeEmployeeLine(employee, 1, D('2026-10-01'), D('2026-10-08'), [], [], scans, true, undefined, undefined, true);
    expect(Number(l.early_leave_deduction)).toBe(0);
  });
});

// TAFSD-438: gaps found in the payroll audit.
describe('payroll: multi-month custom ranges and tax on earned pay', () => {
  it('a 1 Oct – 30 Nov range earns two months, not one', async () => {
    const range = days('2026-10-01', '2026-11-30');
    const svc = build(new Set(range));
    const l = await svc.computeEmployeeLine(employee, 1, D('2026-10-01'), D('2026-11-30'), [], [], fullAttendance('2026-10-01', '2026-11-30'), true);
    expect(Number(l.monthly_pay)).toBeCloseTo(62000, 2);
  });

  it('a range across two months earns each day at its own month rate', async () => {
    // 25–31 Oct = 7/31, 1–5 Nov = 5/30
    const range = days('2026-10-25', '2026-11-05');
    const svc = build(new Set(range));
    const l = await svc.computeEmployeeLine(employee, 1, D('2026-10-25'), D('2026-11-05'), [], [], fullAttendance('2026-10-25', '2026-11-05'), true);
    expect(Number(l.monthly_pay)).toBeCloseTo(31000 * (7 / 31 + 5 / 30), 2);
  });

  it('a mid-cycle leaver is taxed only on the days they are paid for', async () => {
    const range = days('2026-09-26', '2026-10-25');
    const svc = build(new Set(range));
    svc.payrollRules = {
      findEffective: jest.fn(async (type: string) =>
        type === 'INCOME_TAX' ? { value_json: { slabs: [{ min: 0, max: null, fixed_amount: 0, rate_percent: 12 }] } } : null,
      ),
    };
    const rich = { ...employee, monthly_pay: new Prisma.Decimal(300000) };
    const full = await svc.computeEmployeeLine(rich, 1, D('2026-09-26'), D('2026-10-25'), [], [], fullAttendance('2026-09-26', '2026-10-25'), true);
    const leaver = await svc.computeEmployeeLine(
      { ...rich, date_of_leaving: D('2026-09-28') }, 1, D('2026-09-26'), D('2026-10-25'), [], [],
      fullAttendance('2026-09-26', '2026-09-28'), true,
    );
    expect(Number(full.income_tax_deduction)).toBeCloseTo(36000, 0);
    // Paid 3 of 30 days, so 3/30 of the month's tax.
    expect(Number(leaver.income_tax_deduction)).toBeCloseTo(3600, 0);
    expect(Number(leaver.net_pay)).toBeGreaterThan(0);
  });
});
