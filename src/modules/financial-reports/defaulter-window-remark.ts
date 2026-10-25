/**
 * The REMARKS that explain a defaulters-sheet row's EARLIER / LATER cells
 * (TAFSD-418). Owed heads sit in the month they pay for, so a head billed
 * ahead of its month (November tuition on an October voucher) that went unpaid
 * lands in LATER and reads like a future month. The remark says which months
 * those are and that the money was missed, not upcoming.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const label = (idx: number) => `${MONTHS[idx % 12]} ${String(Math.floor(idx / 12)).slice(-2)}`;

/**
 * Month indexes (year * 12 + month - 1) as "MAY–JUL 26, NOV 26": consecutive
 * months collapse into a range, the year once per range end (or on both ends
 * when the range crosses a year).
 */
export function formatMonthRuns(indexes: number[]): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const idx of sorted) {
    const last = runs[runs.length - 1];
    if (last && idx === last[1] + 1) last[1] = idx;
    else runs.push([idx, idx]);
  }
  return runs
    .map(([lo, hi]) => {
      if (lo === hi) return label(lo);
      const sameYear = Math.floor(lo / 12) === Math.floor(hi / 12);
      return `${sameYear ? MONTHS[lo % 12] : label(lo)}–${label(hi)}`;
    })
    .join(', ');
}

/**
 * @param owedMonths the month indexes the row owes something in
 * @param window     the sheet's month columns, inclusive
 */
export function defaulterWindowRemarks(owedMonths: Iterable<number>, window: { lo: number; hi: number }): string[] {
  const months = [...owedMonths];
  const earlier = months.filter((m) => m < window.lo);
  const later = months.filter((m) => m > window.hi);
  const remarks: string[] = [];
  if (earlier.length) {
    remarks.push(`EARLIER = ${formatMonthRuns(earlier)}: UNPAID FROM BEFORE ${label(window.lo)}`);
  }
  if (later.length) {
    remarks.push(
      `LATER = ${formatMonthRuns(later)}: BILLED IN ADVANCE, NOT PAID — CARRIED TO NEXT VOUCHER AS ARREARS`,
    );
  }
  return remarks;
}
