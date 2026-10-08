import { EmployeeStatus, EmploymentSubtype } from '@prisma/client';

/**
 * TAFSD-275: employment_subtype is the source of truth for whether an ACTIVE
 * employee is permanent. is_permanent_employee — which leave policy reads —
 * mirrors it, so every write that touches either goes through here.
 *
 * - ACTIVE: subtype as given (null = not yet classified); the flag follows it.
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
