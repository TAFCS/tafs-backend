import { BadRequestException } from '@nestjs/common';
import { PayrollService } from './payroll.service';

// TAFSD-394: un-finalize a line / a whole run back to pending.

const user = { sub: 'u1', role: 'SUPER_ADMIN' } as any;
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

function build(lines: any[]) {
  const svc = Object.create(PayrollService.prototype) as any;
  const updates: any[] = [];
  const tx = {
    payroll_run_lines: {
      update: jest.fn(async (args: any) => updates.push(args)),
      findMany: jest.fn(async () => [{ payroll_run_id: 62 }]),
    },
  };
  svc.prisma = {
    payroll_runs: { findUnique: jest.fn(async () => ({ id: 62, campus_id: 2, period_start: D('2026-08-26'), period_end: D('2026-09-25') })) },
    payroll_run_lines: {
      findUnique: jest.fn(async () => lines[0]),
      findMany: jest.fn(async () => lines),
    },
    campuses: { findUnique: jest.fn(async () => ({ campus_name: 'GEJ' })) },
    employee_profiles: { findUnique: jest.fn(async () => ({ id: 1, user_id: null })) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  svc.canSeeRun = () => true;
  svc.auditLogs = { log: jest.fn() };
  svc.securityDeposits = { reverseLineDeduction: jest.fn() };
  svc.employeeLoans = { reverseLineDeduction: jest.fn() };
  svc.applyDiscretionaryDeductionsToLine = jest.fn();
  svc.recomputeRunStatus = jest.fn();
  svc.getRun = jest.fn(async () => ({ id: 62 }));
  return { svc, updates };
}

const line = (employee_id: number, extra: any = {}) => ({ id: 100 + employee_id, employee_id, finalized_at: D('2026-09-30'), disbursed_at: null, ...extra });

jest.mock('../../../common/auth/super-admin', () => ({
  ...jest.requireActual('../../../common/auth/super-admin'),
  assertMayChangeEmployee: jest.fn(async () => undefined),
}));

describe('unfinalizeLine', () => {
  it('reverses the postings, clears finalized_at and re-snapshots open lines', async () => {
    const { svc, updates } = build([line(1)]);
    await svc.unfinalizeLine(62, 1, user);
    expect(svc.securityDeposits.reverseLineDeduction).toHaveBeenCalledWith(101, expect.anything());
    expect(svc.employeeLoans.reverseLineDeduction).toHaveBeenCalledWith(101, expect.anything());
    expect(updates[0].data).toEqual({ finalized_at: null, finalized_by: null });
    expect(svc.applyDiscretionaryDeductionsToLine).toHaveBeenCalledWith(62, 1, expect.anything());
    expect(svc.recomputeRunStatus).toHaveBeenCalled();
  });

  it('refuses a line that was already paid out', async () => {
    const { svc } = build([line(1, { disbursed_at: D('2026-10-01') })]);
    await expect(svc.unfinalizeLine(62, 1, user)).rejects.toThrow(/paid out on 2026-10-01/);
  });

  it('refuses a line that is not finalized', async () => {
    const { svc } = build([line(1, { finalized_at: null })]);
    await expect(svc.unfinalizeLine(62, 1, user)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('unfinalizeRun', () => {
  it('un-finalizes every unpaid line and skips paid or blocked ones with a reason', async () => {
    const { svc } = build([line(1), line(2, { disbursed_at: D('2026-10-01') }), line(3)]);
    svc.securityDeposits.reverseLineDeduction.mockImplementation(async (lineId: number) => {
      if (lineId === 103) throw new BadRequestException('later entries');
    });
    const res = await svc.unfinalizeRun(62, user);
    expect(res.unfinalize_summary.unfinalized).toBe(1);
    expect(res.unfinalize_summary.skipped).toEqual([
      { employee_id: 2, reason: 'already paid out on 2026-10-01' },
      { employee_id: 3, reason: 'later entries' },
    ]);
    expect(svc.recomputeRunStatus).toHaveBeenCalledWith(62);
  });

  it('refuses a run with nothing finalized', async () => {
    const { svc } = build([]);
    await expect(svc.unfinalizeRun(62, user)).rejects.toThrow(/No line/);
  });
});
