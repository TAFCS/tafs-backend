/**
 * Severity banding for the Defaulters report.
 *
 * A "month behind" is one distinct (academic_year, target_month) pair among a
 * student's unpaid fee heads dated before the as-of date — exactly the grouping
 * key VouchersService.computeArrears uses to decide how many Rs 1000 late
 * payment surcharges to charge (vouchers.service.ts:5251). So months_behind is
 * also the number of surcharges the next voucher would carry.
 *
 * DEFAULTER (2 months) is the school's escalation threshold: two or more
 * distinct unpaid months is what triggers a "pay immediately" voucher.
 *
 * The frontend mirrors this table in
 * tafs-webapp/app/(dashboard)/financial-reports/_components/severity.ts.
 * Keep the two in sync.
 */

export const SEVERITY_BANDS = [
  { id: 'WATCH', label: 'Watch', minMonths: 1, maxMonths: 1 },
  { id: 'DEFAULTER', label: 'Defaulter', minMonths: 2, maxMonths: 2 },
  { id: 'SEVERE', label: 'Severe', minMonths: 3, maxMonths: 3 },
  { id: 'CRITICAL', label: 'Critical', minMonths: 4, maxMonths: null },
] as const;

export type SeverityBand = (typeof SEVERITY_BANDS)[number]['id'];

export const SEVERITY_BAND_IDS: SeverityBand[] = SEVERITY_BANDS.map((b) => b.id);

/** Months-behind label for the aging view, e.g. "1", "4+". */
export const SEVERITY_BAND_LABELS: Record<SeverityBand, string> = {
  WATCH: '1',
  DEFAULTER: '2',
  SEVERE: '3',
  CRITICAL: '4+',
};

/**
 * Null below 1 — a student with no arrear months is not a defaulter and is
 * never returned by the report.
 */
export function bandForMonthsBehind(monthsBehind: number): SeverityBand | null {
  if (monthsBehind < 1) return null;
  if (monthsBehind === 1) return 'WATCH';
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
