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
