import { computePayrollWindow, currentPayrollPeriodLabel } from '../payroll/payroll-period.util';
import { cycleLabel } from '../installment-cycles.util';

/**
 * TAFSD-621: what each leave type allows, in one place. The service enforces
 * these on create and approve, and the self-context endpoint sends them to the
 * staff app so the form can follow them instead of hardcoding its own copy.
 *
 * leave_types (the table) holds only name / code / is_paid, so the rules live
 * here, keyed by code. A type with no entry is refused.
 */
export interface LeaveTypeRules {
  /** Only staff marked PERMANENT may take it. */
  permanentOnly: boolean;
  /** A request covers exactly one day (start date = end date). */
  singleDay: boolean;
  /**
   * At most this many requests per pay cycle (26th to 25th, the payroll
   * window), counting PENDING and APPROVED ones. Rejected, revoked and
   * cancelled requests don't count. Null = no limit.
   */
  maxPerPayCycle: number | null;
  attachmentRequired: boolean;
  reasonRequired: boolean;
}

const NONE: LeaveTypeRules = {
  permanentOnly: false,
  singleDay: false,
  maxPerPayCycle: null,
  attachmentRequired: false,
  reasonRequired: false,
};

export const LEAVE_TYPE_RULES: Readonly<Record<string, LeaveTypeRules>> = {
  // Mirza, 27 Nov 2026 (#bugs 12): one day only, strictly permanent staff,
  // once a month. Aawaiz, 28 Nov: "month" is the 26th–25th pay cycle.
  CASUAL: { ...NONE, permanentOnly: true, singleDay: true, maxPerPayCycle: 1 },
  SICK: { ...NONE, attachmentRequired: true },
  UNPAID: { ...NONE, reasonRequired: true },
};

export function leaveTypeRules(code: string): LeaveTypeRules | null {
  return LEAVE_TYPE_RULES[code] ?? null;
}

/**
 * A payroll cycle: 26th of one month to the 25th of the next, keyed "YYYY-MM"
 * by the month it ends in (payroll-period.util), so 26 Nov – 25 Dec 2026 is
 * "2026-12".
 */
export type PayCycle = { key: string; start: Date; end: Date; label: string };

export function payCycleByKey(key: string): PayCycle {
  const [y, m] = key.split('-').map(Number);
  const { periodStart, periodEnd } = computePayrollWindow(y, m);
  return { key, start: periodStart, end: periodEnd, label: cycleLabel(periodStart) };
}

/** The pay cycle `date` falls in. */
export function payCycleOf(date: Date): PayCycle {
  return payCycleByKey(currentPayrollPeriodLabel(date));
}

/** Every pay cycle a start..end range touches, in order. */
export function payCyclesBetween(start: Date, end: Date): PayCycle[] {
  const cycles: PayCycle[] = [];
  let cycle = payCycleOf(start);
  while (cycle.start <= end) {
    cycles.push(cycle);
    cycle = payCycleOf(new Date(cycle.end.getTime() + 86_400_000));
  }
  return cycles;
}
