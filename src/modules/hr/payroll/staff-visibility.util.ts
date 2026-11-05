/**
 * TAFSD-478: which payroll runs employees can see in the staff app. A run is
 * shown only once someone releases it, separately from finalizing, so a cycle
 * can be finalized and checked against the manual payroll first. Test runs
 * are never shown.
 */
export const STAFF_VISIBLE_RUN = {
  is_test: false,
  released_to_staff_at: { not: null },
};

export function isStaffVisibleRun(run: {
  is_test: boolean;
  released_to_staff_at: Date | null;
}): boolean {
  return !run.is_test && run.released_to_staff_at !== null;
}
