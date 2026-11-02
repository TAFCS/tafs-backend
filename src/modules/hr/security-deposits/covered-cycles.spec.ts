import { SecurityDepositTransactionType as T } from '@prisma/client';
import { coveredCycles, type CycleTxn } from './security-deposits.service';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const day = (x: Date | undefined) => x?.toISOString().slice(0, 10);

describe('TAFSD-459: coveredCycles', () => {
  it('gives hand-recorded deductions the next cycles in turn, from the plan start', () => {
    const aug: CycleTxn = {
      id: 1,
      type: T.DEDUCTION,
      created_at: d('2026-09-23'),
      payroll_run_line: null,
    };
    const sep: CycleTxn = {
      id: 2,
      type: T.DEDUCTION,
      created_at: d('2026-10-26'),
      payroll_run_line: null,
    };
    const map = coveredCycles(d('2026-07-26'), [sep, aug]);
    expect([day(map.get(aug)), day(map.get(sep))]).toEqual([
      '2026-07-26',
      '2026-08-26',
    ]);
  });

  it('uses the run cycle for payroll deductions and continues after it', () => {
    const run: CycleTxn = {
      id: 1,
      type: T.DEDUCTION,
      created_at: d('2026-10-28'),
      payroll_run_line: { payroll_runs: { period_start: d('2026-09-26') } },
    };
    const manual: CycleTxn = {
      id: 2,
      type: T.DEDUCTION,
      created_at: d('2026-11-01'),
      payroll_run_line: null,
    };
    const refund: CycleTxn = {
      id: 3,
      type: T.REFUND,
      created_at: d('2026-11-02'),
      payroll_run_line: null,
    };
    const map = coveredCycles(d('2026-08-26'), [run, manual, refund]);
    expect([day(map.get(run)), day(map.get(manual)), map.has(refund)]).toEqual([
      '2026-09-26',
      '2026-10-26',
      false,
    ]);
  });
});
