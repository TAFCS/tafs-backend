import { BadRequestException } from '@nestjs/common';
import { PayrollRunKind } from '@prisma/client';
import { PayrollService } from './payroll.service';

// TAFSD-271: custom payroll runs, and no employee on two overlapping real runs.

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const user = { sub: 'u1', role: 'SUPER_ADMIN' } as any;

function build(opts: { employees: any[]; overlapping?: any[]; sameWindowRuns?: any[] }) {
  const svc = Object.create(PayrollService.prototype) as any;
  let nextRunId = 100;
  const created: any[] = [];
  svc.prisma = {
    employee_profiles: { findMany: jest.fn(async () => opts.employees) },
    payroll_runs: {
      findMany: jest.fn(async () => opts.sameWindowRuns ?? []),
      create: jest.fn(async ({ data }: any) => {
        const run = { id: nextRunId++, ...data };
        created.push(run);
        return run;
      }),
      update: jest.fn(async ({ where }: any) => ({ id: where.id })),
    },
    payroll_run_lines: { findMany: jest.fn(async () => opts.overlapping ?? []) },
  };
  svc.scope = { whereForEmployees: () => ({}) };
  svc.auditLogs = { log: jest.fn() };
  svc.assertCampusAccess = jest.fn();
  svc.upsertOpenLines = jest.fn(async (_runId: number, _campusId: number, group: any[]) => ({
    touched: group.length,
    finalized: 0,
    excluded: 0,
  }));
  return { svc, created };
}

const emp = (id: number, campus_id: number) => ({ id, campus_id });

describe('generateCustomRun', () => {
  it('creates one CUSTOM run per campus for the picked dates', async () => {
    const { svc, created } = build({ employees: [emp(1, 10), emp(2, 10), emp(3, 20)] });
    const res = await svc.generateCustomRun(
      { employee_ids: [1, 2, 3], period_start: '2026-10-01', period_end: '2026-10-31' },
      user,
    );
    expect(created).toHaveLength(2);
    expect(created.every((r) => r.kind === PayrollRunKind.CUSTOM)).toBe(true);
    expect(created.map((r) => r.campus_id).sort()).toEqual([10, 20]);
    expect(created[0].period_start).toEqual(D('2026-10-01'));
    expect(created[0].period_end).toEqual(D('2026-10-31'));
    expect(res.runs.map((r: any) => r.touched).sort()).toEqual([1, 2]);
  });

  it('refuses an employee already on an overlapping real run, naming them', async () => {
    const { svc, created } = build({
      employees: [emp(1, 10)],
      overlapping: [
        {
          employee_id: 1,
          employee_profiles: { full_name: 'Ume Farwa', employee_code: 'GKF-02-001166' },
          payroll_runs: { id: 7, period_start: D('2026-09-26'), period_end: D('2026-10-25'), kind: 'REGULAR', campuses: { campus_name: 'KNF' } },
        },
      ],
    });
    await expect(
      svc.generateCustomRun({ employee_ids: [1], period_start: '2026-10-01', period_end: '2026-10-31' }, user),
    ).rejects.toThrow(/Ume Farwa \(GKF-02-001166\).*2026-09-26 to 2026-10-25/);
    expect(created).toHaveLength(0);
  });

  it('ignores lines on the same custom run when re-generating it', async () => {
    const { svc } = build({ employees: [emp(1, 10)], sameWindowRuns: [{ id: 55, campus_id: 10 }] });
    await svc.generateCustomRun({ employee_ids: [1], period_start: '2026-10-01', period_end: '2026-10-31' }, user);
    const where = svc.prisma.payroll_run_lines.findMany.mock.calls[0][0].where;
    expect(where.payroll_run_id).toEqual({ notIn: [55] });
    expect(where.payroll_runs).toEqual({ is_test: false, period_start: { lte: D('2026-10-31') }, period_end: { gte: D('2026-10-01') } });
    expect(svc.prisma.payroll_runs.update).toHaveBeenCalled();
  });

  it('rejects a reversed or too-long range', async () => {
    const { svc } = build({ employees: [emp(1, 10)] });
    await expect(
      svc.generateCustomRun({ employee_ids: [1], period_start: '2026-10-31', period_end: '2026-10-01' }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.generateCustomRun({ employee_ids: [1], period_start: '2026-01-01', period_end: '2026-06-30' }, user),
    ).rejects.toThrow(/at most/);
  });

  it('rejects when a picked employee is not payable', async () => {
    const { svc } = build({ employees: [emp(1, 10)] });
    svc.prisma.employee_profiles.findMany
      .mockResolvedValueOnce([emp(1, 10)])
      .mockResolvedValueOnce([{ id: 2, full_name: 'No Pay', employee_code: null }]);
    await expect(
      svc.generateCustomRun({ employee_ids: [1, 2], period_start: '2026-10-01', period_end: '2026-10-31' }, user),
    ).rejects.toThrow(/No Pay/);
  });
});
