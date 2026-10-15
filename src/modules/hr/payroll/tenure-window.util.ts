/**
 * An employee's active-tenure window(s) inside a payroll cycle. Payroll must
 * only classify, deduct, and pay for days that fall inside one of these
 * windows. Days outside — before a mid-cycle join, after a mid-cycle leave,
 * or in the gap of a rejoin — are *not* absences, they are days the employee
 * was never expected to show up at all, and the salary is prorated to match.
 *
 * All dates are inclusive and normalised to UTC midnight (date-only).
 */
export interface TenureWindow {
  start: Date;
  end: Date;
}

export interface ProgressionPeriod {
  employment_status: string;
  valid_from: Date;
  /** null = still open (current period). */
  valid_to: Date | null;
}

export interface TenureInputs {
  periodStart: Date;
  periodEnd: Date;
  /** Current employee_profiles.join_date — rewritten on rejoin to the rejoin date. */
  joinDate: Date | null;
  /** Current employee_profiles.date_of_leaving — cleared on rejoin. */
  dateOfLeaving: Date | null;
  /**
   * Progression rows for this employee, in any order. Only rows whose
   * [valid_from, valid_to) overlaps the cycle are consulted; the rest are
   * ignored. If omitted, only the current join/leaving fields are used — fine
   * for the simple joiner/leaver cases, but a mid-cycle rejoin will lose its
   * prior tenure window inside the same cycle.
   */
  progression?: ProgressionPeriod[];
}

const OFF_PAYROLL_STATUSES = new Set(['LEFT', 'TERMINATED']);

/** UTC midnight of the given date (strips any time-of-day component). */
function toDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * Returns the inclusive active-tenure windows that fall inside the cycle,
 * sorted by start date and merged where they touch or overlap. Returns an
 * empty array when the employee had no active tenure in the cycle at all
 * (e.g. left before the cycle started, or joins after it ends).
 */
export function computeTenureWindows(inputs: TenureInputs): TenureWindow[] {
  const periodStart = toDateOnly(inputs.periodStart);
  const periodEnd = toDateOnly(inputs.periodEnd);
  if (periodEnd.getTime() < periodStart.getTime()) return [];

  const joinDate = inputs.joinDate ? toDateOnly(inputs.joinDate) : null;
  const leavingDate = inputs.dateOfLeaving ? toDateOnly(inputs.dateOfLeaving) : null;

  const rawWindows: TenureWindow[] = [];

  const progression = (inputs.progression ?? []).map((p) => ({
    employment_status: p.employment_status,
    valid_from: toDateOnly(p.valid_from),
    valid_to: p.valid_to ? toDateOnly(p.valid_to) : null,
  }));

  if (progression.length > 0) {
    // When join_date is null, we don't know when the employee actually started.
    // If the earliest known progression entry is an active status, treat it as
    // if it had always been in effect — otherwise long-tenured employees who
    // got a new progression row mid-cycle would silently disappear from the
    // first part of the cycle. We only back-fill when the earliest entry is
    // active: a leading LEFT/TERMINATED row means they were legitimately gone.
    const earliestEntry = progression.reduce(
      (min, p) => (p.valid_from.getTime() < min.valid_from.getTime() ? p : min),
      progression[0],
    );
    const backfillEarliestActive = !joinDate && !OFF_PAYROLL_STATUSES.has(earliestEntry.employment_status);

    for (const period of progression) {
      if (OFF_PAYROLL_STATUSES.has(period.employment_status)) continue;
      // valid_to is exclusive upper bound in the DB (the next period opens on
      // the same timestamp), so the ACTIVE window's last paid day is
      // valid_to - 1 day; a null valid_to means still open, so the window
      // extends to the end of the cycle.
      const isEarliest = period.valid_from.getTime() === earliestEntry.valid_from.getTime();
      const windowStart = backfillEarliestActive && isEarliest ? periodStart : period.valid_from;
      const windowEnd = period.valid_to
        ? new Date(period.valid_to.getTime() - 86_400_000)
        : periodEnd;
      const clampedStart = maxDate(windowStart, periodStart);
      const clampedEnd = minDate(windowEnd, periodEnd);
      if (clampedStart.getTime() <= clampedEnd.getTime()) {
        rawWindows.push({ start: clampedStart, end: clampedEnd });
      }
    }
  } else {
    // No progression history available — fall back to the current join/leaving
    // fields on the employee profile. Covers the simple cases: a joiner (no
    // leaving), a leaver (no further gap), or an employee active across the
    // whole cycle.
    const windowStart = joinDate ? maxDate(joinDate, periodStart) : periodStart;
    const windowEnd = leavingDate ? minDate(leavingDate, periodEnd) : periodEnd;
    if (windowStart.getTime() <= windowEnd.getTime()) {
      rawWindows.push({ start: windowStart, end: windowEnd });
    }
  }

  // Belt-and-braces: the current join_date / date_of_leaving are the
  // authoritative truth for the LATEST tenure window and guard against stale
  // progression rows (e.g. an open ACTIVE row that was never closed on
  // rejoin). An earlier, closed ACTIVE window that lies entirely before
  // joinDate is kept intact — it's the pre-leave portion of a rejoin cycle
  // and is legitimately paid.
  const clipped: TenureWindow[] = [];
  for (const w of rawWindows) {
    let s = w.start;
    let e = w.end;
    if (joinDate && joinDate.getTime() > s.getTime() && joinDate.getTime() <= e.getTime()) {
      s = joinDate;
    }
    if (leavingDate && e.getTime() > leavingDate.getTime()) {
      e = leavingDate;
    }
    if (s.getTime() <= e.getTime()) {
      clipped.push({ start: s, end: e });
    }
  }

  if (clipped.length === 0) return [];

  // Sort + merge touching/overlapping ranges so the caller gets a canonical
  // minimal set.
  clipped.sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: TenureWindow[] = [clipped[0]];
  for (let i = 1; i < clipped.length; i++) {
    const prev = merged[merged.length - 1];
    const next = clipped[i];
    // "Touching" (next starts the day after prev ends) also merges — a zero-day
    // gap is not a real gap.
    if (next.start.getTime() <= prev.end.getTime() + 86_400_000) {
      prev.end = maxDate(prev.end, next.end);
    } else {
      merged.push(next);
    }
  }

  return merged;
}

/** True if the day (date-only) falls inside any of the given tenure windows. */
export function isDateInAnyWindow(date: Date, windows: TenureWindow[]): boolean {
  const t = toDateOnly(date).getTime();
  for (const w of windows) {
    if (t >= w.start.getTime() && t <= w.end.getTime()) return true;
  }
  return false;
}

/** Total inclusive calendar days covered by the windows. */
export function totalWindowDays(windows: TenureWindow[]): number {
  let total = 0;
  for (const w of windows) {
    total += Math.floor((w.end.getTime() - w.start.getTime()) / 86_400_000) + 1;
  }
  return total;
}

/**
 * Tenure inside one cycle, shaped for display (attendance-by-cycle matrix and
 * its Excel export). Dates are YYYY-MM-DD, windows inclusive. Days outside
 * every window are the same days payroll prorates away — they are shown as
 * "not on roll", never as absences.
 */
export interface CycleTenure {
  windows: { start: string; end: string }[];
  in_tenure_days: number;
  period_days: number;
  /** Set when the employee joined inside the cycle (or joins after it). */
  joined_on: string | null;
  /** Set when the employee left inside the cycle. */
  left_on: string | null;
  /** More than one window: left and came back within the cycle. */
  rejoined: boolean;
}

export type OffRollReason = 'BEFORE_JOIN' | 'AFTER_LEAVE' | 'BETWEEN_TENURES';

const ymd = (d: Date) => toDateOnly(d).toISOString().slice(0, 10);

export function describeCycleTenure(inputs: TenureInputs): CycleTenure {
  const periodStart = toDateOnly(inputs.periodStart);
  const periodEnd = toDateOnly(inputs.periodEnd);
  const windows = computeTenureWindows(inputs);
  const periodDays = Math.floor((periodEnd.getTime() - periodStart.getTime()) / 86_400_000) + 1;

  const first = windows[0];
  const last = windows[windows.length - 1];
  const joinDate = inputs.joinDate ? toDateOnly(inputs.joinDate) : null;
  let joinedOn: string | null = null;
  if (first && first.start.getTime() > periodStart.getTime()) joinedOn = ymd(first.start);
  else if (!first && joinDate && joinDate.getTime() > periodEnd.getTime()) joinedOn = ymd(joinDate);

  return {
    windows: windows.map((w) => ({ start: ymd(w.start), end: ymd(w.end) })),
    in_tenure_days: totalWindowDays(windows),
    period_days: periodDays,
    joined_on: joinedOn,
    left_on: last && last.end.getTime() < periodEnd.getTime() ? ymd(last.end) : null,
    rejoined: windows.length > 1,
  };
}

/** Why a day is off the roll, or null when the employee was on roll that day. */
export function offRollReason(date: string, tenure: Pick<CycleTenure, 'windows'>): OffRollReason | null {
  const { windows } = tenure;
  if (windows.length === 0) return 'BEFORE_JOIN';
  if (windows.some((w) => date >= w.start && date <= w.end)) return null;
  if (date < windows[0].start) return 'BEFORE_JOIN';
  if (date > windows[windows.length - 1].end) return 'AFTER_LEAVE';
  return 'BETWEEN_TENURES';
}
