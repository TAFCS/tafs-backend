import { EmployeeStatus, EmploymentSubtype } from '@prisma/client';

/**
 * TAFSD-275: employment_subtype is the source of truth for whether an ACTIVE
 * employee is permanent. is_permanent_employee — which leave policy reads —
 * mirrors it, so every write that touches either goes through here.
 *
 * - ACTIVE: subtype as given (null = not yet classified); the flag follows it.
 *   CONTRACTUAL is not permanent.
 * - LEFT / TERMINATED: no subtype. The flag is left as it was — it records
 *   whether they had become permanent before going.
 */
export function permanenceFields(
  status: EmployeeStatus,
  subtype: EmploymentSubtype | null | undefined,
): { employment_subtype: EmploymentSubtype | null; is_permanent_employee?: boolean } {
  if (status !== EmployeeStatus.ACTIVE) return { employment_subtype: null };
  const next = subtype ?? null;
  return { employment_subtype: next, is_permanent_employee: next === EmploymentSubtype.PERMANENT };
}

/**
 * Months of service after which an ACTIVE employee becomes permanent, by
 * department name. TAFSD-442 (decided 2026-10-29, replacing TAFSD-321's
 * Academics 12 / Administration 14): teachers — the Academics department —
 * after 14 months, everyone else (any other department, or none) after 12.
 */
export const PERMANENT_AFTER_MONTHS_BY_DEPARTMENT: Readonly<Record<string, number>> = {
  ACADEMICS: 14,
};
export const DEFAULT_PERMANENT_AFTER_MONTHS = 12;

export function monthsUntilPermanent(departmentName: string | null | undefined): number {
  const key = (departmentName ?? '').trim().toUpperCase();
  return PERMANENT_AFTER_MONTHS_BY_DEPARTMENT[key] ?? DEFAULT_PERMANENT_AFTER_MONTHS;
}

/** Latest joining date that counts as `months` of service on `now` (UTC midnight). */
export function permanenceCutoff(months: number, now: Date = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff;
}

/**
 * Whether leave policy treats the employee as permanent: marked permanent, or
 * served their department's period. Contractual staff never are, whatever
 * their length of service.
 */
export function isPermanentForLeave(
  profile: {
    is_permanent_employee: boolean;
    employment_subtype: EmploymentSubtype | null;
    join_date: Date | null;
    departmentName: string | null | undefined;
  },
  now: Date = new Date(),
): boolean {
  if (profile.employment_subtype === EmploymentSubtype.CONTRACTUAL) return false;
  if (profile.is_permanent_employee) return true;
  if (!profile.join_date) return false;
  return profile.join_date <= permanenceCutoff(monthsUntilPermanent(profile.departmentName), now);
}
