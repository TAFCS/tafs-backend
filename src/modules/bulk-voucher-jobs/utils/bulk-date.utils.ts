/**
 * Returns an array of ISO date strings (YYYY-MM-DD) for the 1st of every
 * calendar month between `from` and `to` (inclusive).
 *
 * e.g. "2025-01-01" → "2025-03-31" produces ["2025-01-01", "2025-02-01", "2025-03-01"]
 */
export function getMonthlyFeeDates(from: string, to: string): string[] {
    const dates: string[] = [];
    const start = new Date(from);
    const end = new Date(to);

    // Normalise to 1st of each month
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const endNormalised = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));

    while (cursor <= endNormalised) {
        dates.push(cursor.toISOString().split('T')[0]);
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    return dates;
}
