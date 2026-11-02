import { BadRequestException } from '@nestjs/common';
import { PayrollService } from './payroll.service';

// TAFSD-458: a real run can be generated for just the employees picked in the
// generate modal's filters, leaving everyone else on the campus run alone.

const user = { sub: 'u1', role: 'SUPER_ADMIN' } as any;
const emp = (id: number) => ({ id, campus_id: 10 });

function build(opts: { roster: any[]; existing?: any; profiles?: any[]; locked?: number[]; excluded?: number[] }) {
  const svc = Object.create(PayrollService.prototype) as any;
  svc.prisma = {
    // The roster query filters by campus; the skip-reason / name lookups by id.
    employee_profiles: {
      findMany: jest.fn(async ({ where }: any) =>
        where.campus_id !== undefined ? opts.roster : (opts.profiles ?? []).filter((p) => where.id.in.includes(p.id)),
      ),
    },
    payroll_run_exclusions: {
      findMany: jest.fn(async () => (opts.excluded ?? []).map((employee_id) => ({ employee_id }))),
    },
    payroll_runs: {
      findUnique: jest.fn(async () => opts.existing ?? null),
      create: jest.fn(async ({ data }: any) => ({ id: 100, ...data })),
      update: jest.fn(async ({ where }: any) => ({ id: where.id, ...opts.existing })),
    },
    payroll_run_lines: {
      createMany: jest.fn(async () => ({})),
      findMany: jest.fn(async () => (opts.locked ?? []).map((employee_id) => ({ employee_id }))),
    },
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

  it('skips a pick not on the roster with the reason, and generates the rest', async () => {
    const svc = build({
      roster: [emp(1)],
      profiles: [{ id: 2, full_name: 'Off Payroll', employee_code: 'GEJ-1', campus_id: 10, monthly_pay: 50000, payroll_enabled: false, employment_status: 'ACTIVE' }],
    });
    const res = await svc.generateRun({ campus_id: 10, year: 2026, month: 10, only_employee_ids: [1, 2] }, user);
    expect(svc.computeEmployeeLinesForRange.mock.calls[0][0].map((e: any) => e.id)).toEqual([1]);
    expect(res.skipped_employees).toEqual([
      expect.objectContaining({ employee_id: 2, full_name: 'Off Payroll', reason: expect.stringMatching(/switched off/) }),
    ]);
  });

  it('names why when no pick can be paid', async () => {
    const svc = build({
      roster: [],
      profiles: [{ id: 5, full_name: 'Other Campus', employee_code: null, campus_id: 20, monthly_pay: 1, payroll_enabled: true, employment_status: 'ACTIVE' }],
    });
    await expect(
      svc.generateRun({ campus_id: 10, year: 2026, month: 10, only_employee_ids: [5] }, user),
    ).rejects.toThrow(/Other Campus: Not on this campus/);
    expect(svc.prisma.payroll_runs.create).not.toHaveBeenCalled();
  });

  it('reports picks already finalized or excluded on the existing run', async () => {
    const svc = build({
      roster: [emp(1), emp(2), emp(3)],
      existing: { id: 7, is_test: false, status: 'DRAFT' },
      profiles: [{ id: 2, full_name: 'Done', employee_code: 'A' }, { id: 3, full_name: 'Out', employee_code: 'B' }],
      locked: [2],
      excluded: [3],
    });
    const res = await svc.generateRun({ campus_id: 10, year: 2026, month: 10, only_employee_ids: [1, 2, 3] }, user);
    expect(res.skipped_employees.map((s: any) => [s.employee_id, s.reason.split(' ')[0]])).toEqual([[2, 'Already'], [3, 'Excluded']]);
  });

  it('without the field still generates for the whole roster', async () => {
    const svc = build({ roster: [emp(1), emp(2)], existing: { id: 7, is_test: false, status: 'DRAFT' } });
    await svc.generateRun({ campus_id: 10, year: 2026, month: 10 }, user);
    expect(svc.upsertOpenLines.mock.calls[0][2]).toHaveLength(2);
  });
});
