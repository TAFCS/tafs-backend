import { StaffAttendanceStatus } from '@prisma/client';

/**
 * Whether a check-in is past the expected time by more than the grace window.
 * Same gate as the payroll late-minutes calculation: within grace is on time.
 * Times are wall-clock values stored in UTC fields, so only H:M are compared.
 */
export function isLateCheckIn(checkIn: Date, expectedCheckIn: Date, graceMinutes: number): boolean {
  const checkInMinutes = checkIn.getUTCHours() * 60 + checkIn.getUTCMinutes();
  const expectedMinutes = expectedCheckIn.getUTCHours() * 60 + expectedCheckIn.getUTCMinutes();
  return checkInMinutes - expectedMinutes > graceMinutes;
}

/**
 * A manual override marked LATE whose check-in time is on time is PRESENT.
 *
 * The override form pre-selects the day's current status, so correcting a
 * late punch to an earlier time used to save "LATE" with an on-time check-in —
 * shown as Late with 0 late minutes, and still counted towards the
 * consecutive-lates flag. Only LATE is corrected: PRESENT with a late time is
 * HR deliberately forgiving the lateness and is left alone. Without a
 * check-in or an expected time there is nothing to judge, so LATE stands.
 */
export function effectiveManualStatus<S extends string>(
  status: S,
  checkIn: Date | null | undefined,
  expectedCheckIn: Date | null | undefined,
  graceMinutes: number,
): S | 'PRESENT' {
  if (status !== StaffAttendanceStatus.LATE || !checkIn || !expectedCheckIn) return status;
  return isLateCheckIn(checkIn, expectedCheckIn, graceMinutes) ? status : 'PRESENT';
}
