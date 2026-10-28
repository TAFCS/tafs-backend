/** Fixed school payroll cycle: 26th of previous month through 25th of `month`. */
export function computePayrollWindow(year: number, month: number): { periodStart: Date; periodEnd: Date } {
  const periodEnd = new Date(Date.UTC(year, month - 1, 25));
  const periodStart = new Date(Date.UTC(year, month - 2, 26));
  return { periodStart, periodEnd };
}

/** Label month for the in-progress payroll period containing `date`. */
export function currentPayrollPeriodLabel(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  if (d >= 26) {
    const nextMonth = m === 12 ? 1 : m + 1;
    const nextYear = m === 12 ? y + 1 : y;
    return `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function parsePayrollPeriod(period: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error('Invalid period');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error('Invalid period month');
  return { year, month };
}

/**
 * TAFSD-434: how much of a month's salary a payroll range earns.
 *
 * A range that is one whole pay month — a calendar month (1st -> last day) or
 * the school cycle (26th -> 25th of the next month) — earns the full salary,
 * and its daily rate is monthly pay / days in the range, as before.
 *
 * Any other range (a custom run over, say, 8 days) earns, for each day,
 * monthly pay / days in that day's month (see monthShareOfDay), so a range of
 * two whole calendar months earns two months' pay (TAFSD-438). Returns null
 * for a whole pay month, otherwise the divisor for the daily rate used for
 * deductions: the days in the month the range starts in.
 */
export function partialMonthDivisor(periodStart: Date, periodEnd: Date): number | null {
  const y = periodStart.getUTCFullYear();
  const m = periodStart.getUTCMonth();
  const startDay = periodStart.getUTCDate();
  const daysInStartMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  const isCalendarMonth =
    startDay === 1 &&
    periodEnd.getUTCFullYear() === y &&
    periodEnd.getUTCMonth() === m &&
    periodEnd.getUTCDate() === daysInStartMonth;
  const nextMonth = new Date(Date.UTC(y, m + 1, 25));
  const isSchoolCycle = startDay === 26 && periodEnd.getTime() === nextMonth.getTime();

  return isCalendarMonth || isSchoolCycle ? null : daysInStartMonth;
}

/** TAFSD-438: the share of a month's salary one day earns — 1 / days in its month. */
export function monthShareOfDay(day: Date): number {
  return 1 / new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
}
