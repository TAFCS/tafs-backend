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

// TAFSD-436: the same switches for many lines at once.
describe('bulk statutory waivers', () => {
  const admin = { sub: 'u1', role: 'SUPER_ADMIN' } as any;

  function bulkSvc(openIds: number[]) {
    const svc = Object.create(PayrollService.prototype) as any;
    svc.prisma = {
      payroll_runs: { findUnique: jest.fn(async () => ({ id: 5, campus_id: 1, is_test: false, period_start: D('2026-09-26'), period_end: D('2026-10-25') })) },
      payroll_run_lines: {
        findMany: jest.fn(async ({ where }: any) => {
          const ids = where.employee_id?.in as number[] | undefined;
          return openIds.filter((id) => !ids || ids.includes(id)).map((employee_id) => ({ employee_id }));
        }),
      },
      employee_profiles: { findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: number) => ({ id }))) },
    };
    svc.canSeeRun = () => true;
    svc.assertNoOverlap = jest.fn(async () => undefined);
    svc.upsertOpenLines = jest.fn(async (_r: number, _c: number, emps: unknown[]) => ({ touched: emps.length, finalized: 0, excluded: 0 }));
    svc.getRun = jest.fn(async () => ({ id: 5 }));
    svc.auditLogs = { log: jest.fn() };
    return svc;
  }

  it('applies only the given switches to every open line when no employees are picked', async () => {
    const svc = bulkSvc([1, 2, 3]);
    const out = await svc.setStatutoryWaiversBulk(5, { eobi: true }, admin);
    const [, , emps, , , patch] = svc.upsertOpenLines.mock.calls[0];
    expect(emps.map((e: any) => e.id)).toEqual([1, 2, 3]);
    expect(patch).toEqual({ eobi: true });
    expect(out.bulk_result).toEqual({ updated: 3, skipped: 0 });
  });

  it('limits to the picked employees and counts finalized ones as skipped', async () => {
    const svc = bulkSvc([1, 3]); // 2 is finalized, so not an open line
    const out = await svc.setStatutoryWaiversBulk(5, { employee_ids: [1, 2], sessi: false, income_tax: true }, admin);
    expect(svc.upsertOpenLines.mock.calls[0][2].map((e: any) => e.id)).toEqual([1]);
    expect(svc.upsertOpenLines.mock.calls[0][5]).toEqual({ sessi: false, income_tax: true });
    expect(out.bulk_result).toEqual({ updated: 1, skipped: 1 });
  });

  it('needs at least one switch and refuses test runs', async () => {
    await expect(bulkSvc([1]).setStatutoryWaiversBulk(5, {}, admin)).rejects.toThrow('Choose EOBI');
    const svc = bulkSvc([1]);
    svc.prisma.payroll_runs.findUnique = jest.fn(async () => ({ id: 5, campus_id: 1, is_test: true }));
    await expect(svc.setStatutoryWaiversBulk(5, { eobi: true }, admin)).rejects.toThrow('Test runs');
  });
});
