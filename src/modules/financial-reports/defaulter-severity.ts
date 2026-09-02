/**
 * Severity banding for the Defaulters report.
 *
 * A student appears on this report only if their voucher situation says so —
 * NOT merely because some old unpaid fee_date exists. Two, and only two,
 * situations qualify:
 *
 *  ARRears  — the student has an active voucher (status not VOID, not PAID)
 *             that already bundles genuine arrears: it carries at least one
 *             voucher_arrear_surcharges row. That table is written only when
 *             VouchersService.computeArrears found unpaid heads from an
 *             EARLIER fee_date at the moment that voucher was generated
 *             (vouchers.service.ts:578) — so its existence is proof the
 *             voucher itself, not just some scattered fee row, represents
 *             a real "you owe more than the current bill" situation.
 *             months_behind = COUNT(DISTINCT arrear_year, arrear_month)
 *             across those rows — the same count that determined the Rs 1000
 *             surcharge charged per month.
 *  EXPIRING — the student's only active voucher has ONE fee_date (no bundled
 *             arrears at all) and its own status is EXPIRED: the window to
 *             pay the current period lapsed without anything having rolled
 *             forward into it yet. Not an arrear today, but it becomes one
 *             the moment the next voucher is generated. months_behind = 0
 *             for this category — it exists to give an early warning, not to
 *             claim a count.
 *
 * This deliberately does NOT count a family as behind just because some
 * student_fees row has fee_date < today. A voucher that bills 12 months of
 * tuition at once, all sharing one fee_date, produces 12 different
 * target_month values but is a SINGLE bill, not 12 late payments — until the
 * office actually rolls it into a follow-up voucher as an arrear (at which
 * point voucher_arrear_surcharges rows get written and the ARREARS category
 * picks it up honestly).
 *
 * EXPIRING is intentionally its own category, outside the WATCH..CRITICAL
 * ramp — it is not a severity level, it is a "watch this before it becomes
 * one" flag, and months_behind for it is 0 everywhere, including in
 * min_months_behind filtering (EXPIRING rows bypass that filter).
 *
 * The frontend mirrors this table in
 * tafs-webapp/app/(dashboard)/financial-reports/_components/severity.ts.
 * Keep the two in sync.
 */

export const SEVERITY_BANDS = [
  { id: 'EXPIRING', label: 'Expiring', minMonths: 0, maxMonths: 0 },
  { id: 'WATCH', label: 'Watch', minMonths: 1, maxMonths: 1 },
  { id: 'DEFAULTER', label: 'Defaulter', minMonths: 2, maxMonths: 2 },
  { id: 'SEVERE', label: 'Severe', minMonths: 3, maxMonths: 3 },
  { id: 'CRITICAL', label: 'Critical', minMonths: 4, maxMonths: null },
] as const;

export type SeverityBand = (typeof SEVERITY_BANDS)[number]['id'];

export const SEVERITY_BAND_IDS: SeverityBand[] = SEVERITY_BANDS.map((b) => b.id);

/** Months-behind label for the aging view, e.g. "1", "4+", or a word for EXPIRING. */
export const SEVERITY_BAND_LABELS: Record<SeverityBand, string> = {
  EXPIRING: '0',
  WATCH: '1',
  DEFAULTER: '2',
  SEVERE: '3',
  CRITICAL: '4+',
};

/**
 * Bands an eligible student. Never called for a student who fails the
 * eligibility test in listDefaulters — there is no "0 months, not expiring"
 * band, because that student should not be in the row set at all.
 */
export function bandForMonthsBehind(
  monthsBehind: number,
  category: 'ARREARS' | 'EXPIRING',
): SeverityBand {
  if (category === 'EXPIRING') return 'EXPIRING';
  if (monthsBehind <= 1) return 'WATCH';
  if (monthsBehind === 2) return 'DEFAULTER';
  if (monthsBehind === 3) return 'SEVERE';
  return 'CRITICAL';
}

/**
 * Rs charged per distinct arrear month.
 *
 * The voucher engine still hardcodes this literal at vouchers.service.ts:559,
 * :586 and :5279; those sit inside the voucher-creation transaction and are
 * deliberately not refactored from here. If the school ever changes the rate,
 * all four places move together.
 */
export const LPS_PER_ARREAR_MONTH = 1000;
