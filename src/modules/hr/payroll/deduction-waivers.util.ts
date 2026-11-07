/**
 * TAFSD-471 / TAFSD-472: attendance deductions switched off for one employee
 * on one payroll run, either for the whole cycle by type, or on single days.
 * Payroll-only: the attendance records stay as they are. Stored on the line
 * (payroll_run_lines.deduction_waivers) and carried through every regenerate.
 */
export const DEDUCTION_KINDS = [
  'ABSENCE',
  'HALF_DAY',
  'LATE',
  'EARLY_LEAVE',
  'BREAK',
] as const;
export type DeductionKind = (typeof DEDUCTION_KINDS)[number];

export const DEDUCTION_KIND_LABELS: Record<DeductionKind, string> = {
  ABSENCE: 'Absence',
  HALF_DAY: 'Half day',
  LATE: 'Late arrival',
  EARLY_LEAVE: 'Early leaving',
  BREAK: 'Break',
};

export interface DeductionWaivers {
  /** Off for the whole cycle. */
  types: DeductionKind[];
  /** YYYY-MM-DD -> what is off on that day only. */
  days: Record<string, DeductionKind[]>;
  /** YYYY-MM-DD -> why, when given. */
  reasons: Record<string, string>;
}

const isKind = (v: unknown): v is DeductionKind =>
  DEDUCTION_KINDS.includes(v as DeductionKind);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads whatever is stored (or nothing) into a clean, deduplicated shape. */
export function normalizeDeductionWaivers(raw: unknown): DeductionWaivers {
  const obj =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const types = Array.isArray(obj.types)
    ? [...new Set(obj.types.filter(isKind))]
    : [];
  const days: Record<string, DeductionKind[]> = {};
  const reasons: Record<string, string> = {};
  if (obj.days && typeof obj.days === 'object') {
    for (const [date, kinds] of Object.entries(
      obj.days as Record<string, unknown>,
    )) {
      if (!DATE.test(date) || !Array.isArray(kinds)) continue;
      const clean = [...new Set(kinds.filter(isKind))];
      if (clean.length > 0) days[date] = clean;
    }
  }
  if (obj.reasons && typeof obj.reasons === 'object') {
    for (const [date, reason] of Object.entries(
      obj.reasons as Record<string, unknown>,
    )) {
      if (days[date] && typeof reason === 'string' && reason.trim())
        reasons[date] = reason.trim().slice(0, 300);
    }
  }
  return { types, days, reasons };
}

export const NO_DEDUCTION_WAIVERS: DeductionWaivers = {
  types: [],
  days: {},
  reasons: {},
};

export function hasDeductionWaivers(w: DeductionWaivers): boolean {
  return w.types.length > 0 || Object.keys(w.days).length > 0;
}

export function isDeductionWaived(
  w: DeductionWaivers,
  kind: DeductionKind,
  date: string,
): boolean {
  return w.types.includes(kind) || (w.days[date]?.includes(kind) ?? false);
}

/** Applies one change: replace the whole-cycle types, and/or set one day's kinds (empty clears the day). */
export function applyDeductionWaiverChange(
  current: DeductionWaivers,
  change: {
    types?: DeductionKind[];
    date?: string;
    day_kinds?: DeductionKind[];
    reason?: string | null;
  },
): DeductionWaivers {
  const next: DeductionWaivers = {
    types: change.types ? [...new Set(change.types)] : [...current.types],
    days: { ...current.days },
    reasons: { ...current.reasons },
  };
  if (change.date) {
    const kinds = [...new Set(change.day_kinds ?? [])];
    if (kinds.length > 0) {
      next.days[change.date] = kinds;
      if (change.reason?.trim())
        next.reasons[change.date] = change.reason.trim().slice(0, 300);
      else if (change.reason !== undefined) delete next.reasons[change.date];
    } else {
      delete next.days[change.date];
      delete next.reasons[change.date];
    }
  }
  return normalizeDeductionWaivers(next);
}

/** "Late arrival and break off for the cycle; early leaving off on 14 Oct" — for the audit log. */
export function describeDeductionWaivers(w: DeductionWaivers): string {
  const parts: string[] = [];
  if (w.types.length > 0)
    parts.push(
      `${w.types.map((k) => DEDUCTION_KIND_LABELS[k]).join(', ')} off for the cycle`,
    );
  for (const [date, kinds] of Object.entries(w.days).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    parts.push(
      `${kinds.map((k) => DEDUCTION_KIND_LABELS[k]).join(', ')} off on ${date}${w.reasons[date] ? ` (${w.reasons[date]})` : ''}`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : 'no deductions switched off';
}
