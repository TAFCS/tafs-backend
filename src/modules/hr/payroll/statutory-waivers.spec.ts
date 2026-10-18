import { Prisma } from '@prisma/client';
import { PayrollService } from './payroll.service';

// TAFSD-383: EOBI / SESSI / income tax can be waived for one line in one cycle.

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

const RULES: Record<string, unknown> = {
  EOBI: { employee_percent: 1, employer_percent: 5, wage_base_amount: 37000 },
  SESSI: { employer_percent: 6, wage_base_amount: 37000 },
  INCOME_TAX: { slabs: [{ min: 0, max: null, fixed_amount: 0, rate_percent: 10 }] },
};

function build() {
  const svc = Object.create(PayrollService.prototype) as any;
  svc.expectedTimes = { resolveExpectedTimes: jest.fn(async () => ({ expectedCheckIn: null, expectedCheckOut: null, graceMinutes: 0 })) };
  svc.calendarResolver = {
    resolveStaffDayFromRows: () => ({ isWorkingDay: false, dayType: 'WEEKEND', description: 'Weekend', source: 'SCHEDULE' }),
  };
  svc.payrollRules = { findEffective: jest.fn(async (type: string) => ({ value_json: RULES[type] })) };
  return svc;
}

const employee = {
  id: 9, monthly_pay: new Prisma.Decimal(120000), reporting_time: null, leaving_time: null, late_relaxation_minutes: null,
  department_id: 1, staff_category_id: 1, staff_categories: { code: 'T' }, days_per_week: 5, employee_work_schedules: [],
  check_in_source: 'FIXED', join_date: D('2020-01-01'), date_of_leaving: null, eobi_exempt: false, sessi_exempt: false,
};

const line = (waivers?: { eobi: boolean; sessi: boolean; income_tax: boolean }) =>
  build().computeEmployeeLine(employee, 1, D('2026-09-26'), D('2026-10-25'), [], [], [], true, undefined, undefined, false, undefined, waivers);

describe('per-cycle statutory waivers', () => {
  it('charges EOBI, SESSI and income tax by default', async () => {
    const l = await line();
    expect(Number(l.eobi_deduction)).toBe(370);
    expect(Number(l.sessi_employer_cost)).toBe(2220);
    expect(Number(l.income_tax_deduction)).toBeGreaterThan(0);
    expect(l.eobi_waived || l.sessi_waived || l.income_tax_waived).toBe(false);
  });

  it('a waived item is zero for this line and the rest still apply', async () => {
    const l = await line({ eobi: true, sessi: false, income_tax: true });
    expect(Number(l.eobi_deduction)).toBe(0);
    expect(Number(l.eobi_employer_cost)).toBe(0);
    expect(Number(l.income_tax_deduction)).toBe(0);
    expect(Number(l.sessi_employer_cost)).toBe(2220);
    expect(Number(l.net_pay)).toBe(120000);
    expect(l).toMatchObject({ eobi_waived: true, sessi_waived: false, income_tax_waived: true, eobi_exempt: false });
  });
});
