import { cycleCollectedOutsidePayroll, cycleLabel, nextCollectionCycle, parseCycleStart, type CycleTxn } from './installment-cycles.util';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const day = (x: Date) => x.toISOString().slice(0, 10);
const manual = (id: number, at: string): CycleTxn => ({ id, type: 'DEDUCTION', created_at: d(at), payroll_run_line_id: null, payroll_run_line: null });
const payroll = (id: number, at: string, cycle: string): CycleTxn => ({
  id,
  type: 'DEDUCTION',
  created_at: d(at),
  payroll_run_line_id: 100 + id,
  payroll_run_line: { payroll_runs: { period_start: d(cycle) } },
});

describe('TAFSD-589: installment cycles', () => {
  it('next cycle is the plan start until something is taken, then the one after the last', () => {
    expect(day(nextCollectionCycle(d('2026-09-26'), []))).toBe('2026-09-26');
    // The Aug + Sep 2026 backfills on a July plan: October is next.
    expect(day(nextCollectionCycle(d('2026-07-26'), [manual(1, '2026-09-23'), manual(2, '2026-11-10')]))).toBe('2026-09-26');
  });

  it('a hand-recorded installment after a payroll one covers the following cycle', () => {
    const txns = [payroll(1, '2026-10-28', '2026-09-26'), manual(2, '2026-11-20')];
    expect(day(nextCollectionCycle(d('2026-08-26'), txns))).toBe('2026-11-26');
    expect(cycleCollectedOutsidePayroll(d('2026-08-26'), txns, d('2026-10-26'))).toBe(true);
    // Payroll took September itself: that is not "collected outside payroll".
    expect(cycleCollectedOutsidePayroll(d('2026-08-26'), txns, d('2026-09-26'))).toBe(false);
  });

  it('refunds, lump sums and other entries cover no cycle', () => {
    const txns = [manual(1, '2026-10-01'), { id: 2, type: 'LUMP_SUM_REPAYMENT', created_at: d('2026-10-02'), payroll_run_line: null }];
    expect(day(nextCollectionCycle(d('2026-09-26'), txns))).toBe('2026-10-26');
  });

  it('reads the list shape too, where only payroll_run_line is selected', () => {
    const listRow: CycleTxn = { id: 1, type: 'DEDUCTION', created_at: d('2026-10-01'), payroll_run_line: null };
    expect(cycleCollectedOutsidePayroll(d('2026-09-26'), [listRow], d('2026-09-26'))).toBe(true);
  });

  it('parses only a cycle start and labels it', () => {
    expect(parseCycleStart('2026-09-25')).toBeNull();
    expect(parseCycleStart('nope')).toBeNull();
    expect(day(parseCycleStart('2026-09-26')!)).toBe('2026-09-26');
    expect(cycleLabel(d('2026-09-26'))).toBe('26 Sep – 25 Oct 2026');
    expect(cycleLabel(d('2026-12-26'))).toBe('26 Dec – 25 Jan 2027');
  });
});
