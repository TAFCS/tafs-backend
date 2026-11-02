import { BadRequestException } from '@nestjs/common';
import { PayrollService } from './payroll.service';

// TAFSD-458: a real run can be generated for just the employees picked in the
// generate modal's filters, leaving everyone else on the campus run alone.

const user = { sub: 'u1', role: 'SUPER_ADMIN' } as any;
const emp = (id: number) => ({ id, campus_id: 10 });

function build(opts: { roster: any[]; existing?: any }) {
  const svc = Object.create(PayrollService.prototype) as any;
  svc.prisma = {
    employee_profiles: { findMany: jest.fn(async () => opts.roster) },
    payroll_runs: {
      findUnique: jest.fn(async () => opts.existing ?? null),
      create: jest.fn(async ({ data }: any) => ({ id: 100, ...data })),
      update: jest.fn(async ({ where }: any) => ({ id: where.id, ...opts.existing })),
    },
    payroll_run_lines: { createMany: jest.fn(async () => ({})) },
  };
  svc.auditLogs = { log: jest.fn() };
  svc.assertCampusAccess = jest.fn();
  svc.findOverlappingLines = jest.fn(async () => []);
  svc.computeEmployeeLinesForRange = jest.fn(async (emps: any[]) => emps.map((e) => ({ employee_id: e.id })));
  svc.detectFlagsForLine = jest.fn(() => []);
  svc.syncPayrollFlagsForEmployee = jest.fn();
  svc.upsertOpenLines = jest.fn(async (_r: number, _c: number, group: any[]) => ({ touched: group.length, finalized: 0, excluded: 0 }));
  svc.getRun = jest.fn(async (id: number) => ({ id }));
  return svc;
}

describe('generateRun with only_employee_ids', () => {
  it('recomputes only the picked employees on an existing campus run', async () => {
    const svc = build({ roster: [emp(1), emp(2), emp(3)], existing: { id: 7, is_test: false, status: 'DRAFT' } });
    await svc.generateRun({ campus_id: 10, year: 2026, month: 10, only_employee_ids: [2, 3] }, user);
    const group = svc.upsertOpenLines.mock.calls[0][2];
    expect(group.map((e: any) => e.id)).toEqual([2, 3]);
    expect(svc.prisma.payroll_runs.create).not.toHaveBeenCalled();
  });

  it('creates the regular (non-test) campus run with just the picked employees', async () => {
    const svc = build({ roster: [emp(1), emp(2)] });
    await svc.generateRun({ campus_id: 10, year: 2026, month: 10, only_employee_ids: [1] }, user);
    expect(svc.prisma.payroll_runs.create.mock.calls[0][0].data.is_test).toBe(false);
    expect(svc.computeEmployeeLinesForRange.mock.calls[0][0].map((e: any) => e.id)).toEqual([1]);
  });

  it('refuses an employee who is not on the campus roster for the cycle', async () => {
    const svc = build({ roster: [emp(1)] });
    await expect(
      svc.generateRun({ campus_id: 10, year: 2026, month: 10, only_employee_ids: [1, 99] }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.prisma.payroll_runs.create).not.toHaveBeenCalled();
  });

  it('without the field still generates for the whole roster', async () => {
    const svc = build({ roster: [emp(1), emp(2)], existing: { id: 7, is_test: false, status: 'DRAFT' } });
    await svc.generateRun({ campus_id: 10, year: 2026, month: 10 }, user);
    expect(svc.upsertOpenLines.mock.calls[0][2]).toHaveLength(2);
  });
});
