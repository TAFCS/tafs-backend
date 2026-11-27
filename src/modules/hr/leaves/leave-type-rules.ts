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
   * At most this many requests per calendar month, counting PENDING and
   * APPROVED ones. Rejected, revoked and cancelled requests don't count.
   * Null = no limit.
   */
  maxPerMonth: number | null;
  attachmentRequired: boolean;
  reasonRequired: boolean;
}

const NONE: LeaveTypeRules = {
  permanentOnly: false,
  singleDay: false,
  maxPerMonth: null,
  attachmentRequired: false,
  reasonRequired: false,
};

export const LEAVE_TYPE_RULES: Readonly<Record<string, LeaveTypeRules>> = {
  // Mirza, 27 Nov 2026 (#bugs 12): one day only, strictly permanent staff, once a month.
  CASUAL: { ...NONE, permanentOnly: true, singleDay: true, maxPerMonth: 1 },
  SICK: { ...NONE, attachmentRequired: true },
  UNPAID: { ...NONE, reasonRequired: true },
};

export function leaveTypeRules(code: string): LeaveTypeRules | null {
  return LEAVE_TYPE_RULES[code] ?? null;
}

/** First and last day (UTC midnight) of the calendar month `date` falls in. */
export function calendarMonthBounds(date: Date): { start: Date; end: Date } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 0)) };
}

/** "2026-11" */
export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** "November 2026" */
export function monthLabel(date: Date): string {
  return date.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Every "YYYY-MM" a start..end range touches. */
export function monthKeysBetween(start: Date, end: Date): string[] {
  const keys: string[] = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }
  return keys;
}
