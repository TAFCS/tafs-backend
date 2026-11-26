/**
 * TAFSD-604: Consolidated Recoveries — what each student's deposits in a
 * period paid, by fee head and by fee month or month received. Pure, so the money rules are tested
 * apart from the database (consolidated-recoveries.spec.ts); the sheet itself
 * is FinancialReportsService.exportConsolidatedRecoveries.
 */

/** The banner under the school name, as the defaulters sheet has its own. */
export const CONSOLIDATED_RECOVERIES_TITLE = 'CONSOLIDATED RECOVERIES';

/**
 * Which month a recovery goes under: `fee` — the month the fee head was billed
 * for (its fee_date), as on the receivables sheet; `deposit` — the month the
 * money was received, in Pakistan time.
 */
export type RecoveryMonthBy = 'fee' | 'deposit';

/** The line under the period saying which months the columns are. */
export const RECOVERY_MONTH_BY_LINE: Record<RecoveryMonthBy, string> = {
  fee: 'MONTHS: FEE MONTH PAID FOR',
  deposit: 'MONTHS: MONTH RECEIVED',
};

export interface RecoveryAllocationInput {
  /** deposit_allocations.type: FEE_HEAD, LATE_FEE, SURCHARGE or DISCOUNT. */
  type: string;
  amount: number;
  /** The head's fee month, year * 12 + (month - 1); null when unknown. */
  month: number | null;
  /** The fee head (fee type) name; used for FEE_HEAD rows only. */
  head: string;
}

export interface RecoveryDepositInput {
  id: number;
  studentId: number;
  depositDate: Date;
  /** Cash for a cash deposit; the credit spent for a credit payment (Rule E). */
  totalAmount: number;
  /** What went to family credit. */
  excessAmount: number;
  fromCredit: boolean;
  paymentMethod: string | null;
  allocations: RecoveryAllocationInput[];
}

export interface RecoveryDepositLine {
  id: number;
  date: Date;
  amount: number;
  method: string | null;
  fromCredit: boolean;
  toCredit: number;
  unallocated: number;
}

export interface RecoverySummary {
  /** month index -> fee head -> recovered. Month -1: a head with no fee month. */
  months: Map<number, Map<string, number>>;
  feeHeads: number;
  lps: number;
  totalRecovered: number;
  cash: number;
  fromCredit: number;
  toCredit: number;
  /** Money on a deposit with no allocation behind it (old data only). */
  unallocated: number;
  /** DISCOUNT allocations: not money, noted in REMARKS. */
  discountApplied: number;
  deposits: RecoveryDepositLine[];
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * One summary per student. For every student:
 * cash + fromCredit = totalRecovered + toCredit + unallocated.
 */
export function summarizeRecoveries(
  deposits: RecoveryDepositInput[],
  monthBy: RecoveryMonthBy = 'fee',
): Map<number, RecoverySummary> {
  const out = new Map<number, RecoverySummary>();
  for (const d of deposits) {
    const receivedIn = recoveryMonthIndex(d.depositDate);
    let s = out.get(d.studentId);
    if (!s) {
      s = {
        months: new Map(),
        feeHeads: 0,
        lps: 0,
        totalRecovered: 0,
        cash: 0,
        fromCredit: 0,
        toCredit: 0,
        unallocated: 0,
        discountApplied: 0,
        deposits: [],
      };
      out.set(d.studentId, s);
    }
    let allocated = 0;
    for (const a of d.allocations) {
      if (a.type === 'FEE_HEAD') {
        const idx = monthBy === 'deposit' ? receivedIn : (a.month ?? -1);
        const month = s.months.get(idx) ?? new Map<string, number>();
        month.set(a.head, round((month.get(a.head) ?? 0) + a.amount));
        s.months.set(idx, month);
        s.feeHeads = round(s.feeHeads + a.amount);
        allocated += a.amount;
      } else if (a.type === 'LATE_FEE' || a.type === 'SURCHARGE') {
        s.lps = round(s.lps + a.amount);
        allocated += a.amount;
      } else if (a.type === 'DISCOUNT') {
        s.discountApplied = round(s.discountApplied + a.amount);
      }
    }
    if (d.fromCredit) s.fromCredit = round(s.fromCredit + d.totalAmount);
    else s.cash = round(s.cash + d.totalAmount);
    s.toCredit = round(s.toCredit + d.excessAmount);
    const unallocated = round(d.totalAmount - d.excessAmount - allocated);
    s.unallocated = round(s.unallocated + unallocated);
    s.totalRecovered = round(s.feeHeads + s.lps);
    s.deposits.push({
      id: d.id,
      date: d.depositDate,
      amount: d.totalAmount,
      method: d.paymentMethod,
      fromCredit: d.fromCredit,
      toCredit: d.excessAmount,
      unallocated,
    });
  }
  return out;
}

/** The Pakistan-time month a moment falls in, as year * 12 + (month - 1). */
export function recoveryMonthIndex(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return get('year') * 12 + get('month') - 1;
}

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

/** "12 NOV 2026", in Pakistan time — deposit_date holds the moment, as the webapp shows it. */
export function recoveryDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return `${get('day')} ${MONTHS[get('month') - 1]} ${get('year')}`;
}

/** "BANK TRANSFER" from "bank_transfer"; blank when none was recorded. */
function methodLabel(method: string | null): string {
  return (method ?? '').replace(/[_-]+/g, ' ').trim().toUpperCase();
}

const money = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * REMARKS: one line per deposit — "12 NOV 2026 · 15,000 · CASH", with
 * "FROM FAMILY CREDIT", "+5,000 TO FAMILY CREDIT" or "NO FEE HEAD RECORDED"
 * where it applies — then any discount the deposits applied.
 */
export function recoveryRemarks(s: RecoverySummary): string[] {
  const lines = s.deposits.map((d) => {
    const parts = [recoveryDate(d.date), money(d.amount)];
    if (d.fromCredit) parts.push('FROM FAMILY CREDIT');
    else if (methodLabel(d.method)) parts.push(methodLabel(d.method));
    if (d.toCredit > 0) parts.push(`+${money(d.toCredit)} TO FAMILY CREDIT`);
    if (d.unallocated !== 0)
      parts.push(`NO FEE HEAD RECORDED FOR ${money(d.unallocated)}`);
    return parts.join(' · ');
  });
  if (s.discountApplied > 0)
    lines.push(`DISCOUNT APPLIED ${money(s.discountApplied)}`);
  return lines;
}
