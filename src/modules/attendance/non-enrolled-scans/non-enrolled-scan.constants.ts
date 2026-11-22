import { student_status } from '@prisma/client';

/**
 * TAFSD-556: check-ins by students who are no longer enrolled.
 * Kept apart from the service so the scan processor, the read-only past-scan
 * script and the specs can import them freely.
 */

/**
 * Which statuses count as "quit". A scan by a student in one of these is
 * flagged. SOFT_ADMISSION and QUICK_ADMISSION are left out on purpose: those
 * students may legitimately be attending while their admission is finished.
 * Pending Hassan's confirmation; change this list and nothing else.
 */
export const NON_ENROLLED_FLAG_STATUSES: readonly student_status[] = [
  student_status.LEFT,
  student_status.EXPELLED,
  student_status.GRADUATED,
];

export function isNonEnrolledFlagStatus(status: student_status | string | null | undefined): status is student_status {
  return status != null && (NON_ENROLLED_FLAG_STATUSES as readonly string[]).includes(status);
}

/** The report tile and its actions. Web tile, so default-deny: granted per person. */
export const NON_ENROLLED_TILE_ID = 'attendance.non_enrolled_check_ins';
export const NON_ENROLLED_ACTION = {
  view: `${NON_ENROLLED_TILE_ID}#view`,
  export: `${NON_ENROLLED_TILE_ID}#export`,
  alerts: `${NON_ENROLLED_TILE_ID}#alerts`,
} as const;
export const NON_ENROLLED_ALERTS_ACTION_ID = 'alerts';

export const NON_ENROLLED_ALERT_KIND = 'NON_ENROLLED_CHECK_IN';
export const NON_ENROLLED_REPORT_PATH = '/attendance/non-enrolled-check-ins';

export const STATUS_LABEL: Record<string, string> = {
  LEFT: 'Left',
  EXPELLED: 'Expelled',
  GRADUATED: 'Graduated',
  SOFT_ADMISSION: 'Soft admission',
  QUICK_ADMISSION: 'Quick admission',
  ENROLLED: 'Enrolled',
};
