/**
 * Which payroll cycle (26th–25th) each installment of a loan or security
 * deposit covered. Shared by both, because both schedules are queues: every
 * finalized payroll line pops the next slot, and so does an installment
 * marked collected outside payroll (TAFSD-589).
 *
 * A payroll deduction covers its run's cycle. One recorded by hand (no payroll
 * line: the Aug / Sep 2026 NPD backfills, or "Mark collected") covers the cycle
 * after the previous installment, or the plan's first cycle. Every other kind
 * of entry (refund, forfeit, lump sum, write-off) covers none.
 */

export type CycleTxn = {
  id?: number;
  type: string;
  created_at?: Date;
  payroll_run_line_id?: number | null;
  payroll_run_line?: { payroll_runs: { period_start: Date } } | null;
};

const DEDUCTION = 'DEDUCTION';

export function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Start (the 26th) of the cycle after the one starting on `periodStart`. */
export function nextCycleStart(periodStart: Date): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 26));
}

/** The 25th that ends the cycle starting on `periodStart`. */
export function cycleEnd(periodStart: Date): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 25));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "26 Sep – 25 Oct 2026" */
export function cycleLabel(periodStart: Date): string {
  const end = cycleEnd(periodStart);
  return `26 ${MONTHS[periodStart.getUTCMonth()]} – 25 ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
}

/** Parses a YYYY-MM-DD cycle start and refuses anything that isn't a 26th. */
export function parseCycleStart(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCDate() === 26 ? date : null;
}

export function coveredCycles<T extends CycleTxn>(startPeriodStart: Date, transactions: T[]): Map<T, Date> {
  const out = new Map<T, Date>();
  let prev: Date | null = null;
  const ordered = [...transactions].sort(
    (a, b) => (a.created_at?.getTime() ?? 0) - (b.created_at?.getTime() ?? 0) || (a.id ?? 0) - (b.id ?? 0),
  );
  for (const txn of ordered) {
    if (txn.type !== DEDUCTION) continue;
    const start: Date = txn.payroll_run_line?.payroll_runs.period_start ?? (prev ? nextCycleStart(prev) : startPeriodStart);
    out.set(txn, start);
    if (!prev || start > prev) prev = start;
  }
  return out;
}

/**
 * The cycle the next payroll (or the next "Mark collected") takes: the one
 * after the last installment, or the plan's first cycle.
 */
export function nextCollectionCycle(startPeriodStart: Date, transactions: CycleTxn[]): Date {
  let last: Date | null = null;
  for (const start of coveredCycles(startPeriodStart, transactions).values()) {
    if (!last || start > last) last = start;
  }
  if (!last) return startPeriodStart;
  const next = nextCycleStart(last);
  return next > startPeriodStart ? next : startPeriodStart;
}

/**
 * True when an installment recorded outside payroll already covers this
 * cycle. Payroll for that cycle must then deduct nothing and leave the
 * schedule alone, or the employee is charged twice.
 */
export function cycleCollectedOutsidePayroll(
  startPeriodStart: Date,
  transactions: CycleTxn[],
  periodStart: Date,
): boolean {
  for (const [txn, start] of coveredCycles(startPeriodStart, transactions)) {
    const manual = txn.payroll_run_line_id === undefined ? !txn.payroll_run_line : txn.payroll_run_line_id === null;
    if (manual && start.getTime() === periodStart.getTime()) return true;
  }
  return false;
}
