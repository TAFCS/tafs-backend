import { Prisma } from '@prisma/client';
import { PayrollService } from './payroll.service';

// TAFSD-372: from the 26 Oct 2026 cycle, each day is paid at the pay in effect on it.

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const pktStart = (iso: string) => new Date(D(iso).getTime() - 5 * 3600 * 1000);

function build(workingDays: Set<string>) {
  const svc = Object.create(PayrollService.prototype) as any;
  svc.expectedTimes = { resolveExpectedTimes: jest.fn(async () => ({ expectedCheckIn: null, expectedCheckOut: null, graceMinutes: 0 })) };
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
  id: 9, monthly_pay: new Prisma.Decimal(50000), reporting_time: null, leaving_time: null, late_relaxation_minutes: null,
  department_id: 1, staff_category_id: 1, staff_categories: { code: 'T' }, days_per_week: 5, employee_work_schedules: [],
  check_in_source: 'FIXED', join_date: D('2020-01-01'), date_of_leaving: null,
};

async function line(start: string, end: string, raiseOn: string, absent: string[] = []) {
  const svc = build(new Set(absent));
  const periods = [
    { employment_status: 'ACTIVE', valid_from: D('2020-01-01'), valid_to: pktStart(raiseOn), monthly_pay: new Prisma.Decimal(40000) },
    { employment_status: 'ACTIVE', valid_from: pktStart(raiseOn), valid_to: null, monthly_pay: new Prisma.Decimal(50000) },
  ];
  return svc.computeEmployeeLine(employee, 1, D(start), D(end), [], [], [], true, undefined, undefined, false, periods);
}

describe('payroll pays each day at the pay in effect on it', () => {
  it('a raise effective mid-cycle pays the old rate before it and the new rate from it (26 Oct cycle on)', async () => {
    // 26 Oct – 25 Nov = 31 days; raise on 10 Nov → 15 days at 40,000, 16 at 50,000.
    const l = await line('2026-10-26', '2026-11-25', '2026-11-10');
    expect(Number(l.monthly_pay)).toBeCloseTo((15 * 40000 + 16 * 50000) / 31, 2);
    expect(Number(l.net_pay)).toBeCloseTo((15 * 40000 + 16 * 50000) / 31, 2);
  });

  it('an absence is deducted at that day\'s rate', async () => {
    const before = await line('2026-10-26', '2026-11-25', '2026-11-10', ['2026-11-02']);
    const after = await line('2026-10-26', '2026-11-25', '2026-11-10', ['2026-11-16']);
    expect(Number(before.absence_deduction)).toBeCloseTo(40000 / 31, 2);
    expect(Number(after.absence_deduction)).toBeCloseTo(50000 / 31, 2);
  });

  it('cycles before 26 Oct 2026 keep paying the current pay for the whole cycle', async () => {
    const l = await line('2026-09-26', '2026-10-25', '2026-10-10');
    expect(Number(l.monthly_pay)).toBe(50000);
  });
});
