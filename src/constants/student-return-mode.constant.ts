import { StudentStatus } from './student-status.constant';

/**
 * How a departed student is being brought back into active enrollment.
 *
 * REINSTATED — the departure is being reversed. The student resumes the exact
 *              placement they held; the absence is a gap inside one continuous
 *              enrollment. No new admission record.
 * READMITTED — the student returns as a fresh admission. Class, section, house,
 *              GR and academic year are re-decided and a new admission record is
 *              written to Application history.
 */
export enum StudentReturnMode {
  REINSTATED = 'REINSTATED',
  READMITTED = 'READMITTED',
}

/** Statuses a student can return *from*. */
export const DEPARTURE_STATUSES: StudentStatus[] = [
  StudentStatus.LEFT,
  StudentStatus.EXPELLED,
  StudentStatus.GRADUATED,
];

export function isDepartureStatus(status: string | null | undefined): boolean {
  return DEPARTURE_STATUSES.includes(status as StudentStatus);
}

/** `student_flags` prefixes opened by each departure, closed on return. */
export const DEPARTURE_FLAG_PREFIXES = ['LEFT_LOG_', 'EXPELLED_LOG_', 'GRADUATED_LOG_'];
