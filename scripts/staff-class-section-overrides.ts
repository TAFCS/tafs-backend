/**
 * Manual class-section assignments and no-assignment flags from staff_mapping_review.txt.
 * Used when CSV values cannot be auto-parsed or duplicate Staff Type text.
 *
 * Aug 2026 teacher allocation overrides synced from apply-teacher-allocation-2026.ts
 */

export interface ClassSectionAssignment {
  classId: number;
  sectionIds: number[];
}

/** Reviewed overrides keyed by employee_code (case-insensitive lookup via normCode). */
export const MANUAL_CLASS_SECTION_OVERRIDES: Record<string, ClassSectionAssignment[]> = {
  // Johar Pre-Primary (Aug 2026)
  '02-001485': [{ classId: 1, sectionIds: [1] }],
  '02-001508': [{ classId: 1, sectionIds: [2] }],
  '02-001511': [{ classId: 1, sectionIds: [1, 2] }],
  '02-001264': [{ classId: 2, sectionIds: [1] }],
  '02-001417': [{ classId: 2, sectionIds: [1] }],
  '02-001476': [{ classId: 2, sectionIds: [2] }],
  '02-001470': [{ classId: 2, sectionIds: [2] }],
  '02-001509': [{ classId: 2, sectionIds: [1, 2, 3] }],
  '02-001166': [{ classId: 3, sectionIds: [1] }],
  '02-001488': [{ classId: 3, sectionIds: [2] }],
  '02-001404': [{ classId: 3, sectionIds: [3] }],
  '02-001192': [{ classId: 3, sectionIds: [1, 2, 3] }],
  '02-0861': [
    { classId: 1, sectionIds: [1, 2] },
    { classId: 2, sectionIds: [1, 2, 3] },
    { classId: 3, sectionIds: [1, 2, 3] },
  ],
  '02-001493': [
    { classId: 1, sectionIds: [1, 2] },
    { classId: 2, sectionIds: [1, 2, 3] },
    { classId: 3, sectionIds: [1, 2, 3] },
  ],

  // Pre-existing overrides (Johar seniors)
  '02-001273': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [2] },
  ],
  '02-001468': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
  ],

  // Secondary (Johar)
  '02-00644': [
    { classId: 15, sectionIds: [1, 2, 3] },
    { classId: 16, sectionIds: [1, 2, 3] },
    { classId: 17, sectionIds: [1, 2, 3] },
    { classId: 19, sectionIds: [1, 2, 3] },
  ],
  '02-001138': [
    { classId: 15, sectionIds: [1, 2, 3] },
    { classId: 16, sectionIds: [1, 2, 3] },
    { classId: 17, sectionIds: [1, 2, 3] },
    { classId: 19, sectionIds: [1, 2, 3] },
  ],
  '02-001359': [
    { classId: 15, sectionIds: [1, 2, 3] },
    { classId: 16, sectionIds: [1, 2, 3] },
    { classId: 17, sectionIds: [1, 2, 3] },
    { classId: 18, sectionIds: [1, 2, 3] },
    { classId: 19, sectionIds: [1, 2, 3] },
  ],
  '02-001486': [
    { classId: 4, sectionIds: [1, 2, 3, 4] },
    { classId: 5, sectionIds: [1, 2, 3, 4] },
  ],
  '02-001487': [{ classId: 15, sectionIds: [1, 2, 3] }, { classId: 16, sectionIds: [1, 2, 3] }, { classId: 17, sectionIds: [1, 2, 3] }, { classId: 18, sectionIds: [1, 2, 3] }, { classId: 19, sectionIds: [1, 2, 3] }],
  '02-001506': [{ classId: 15, sectionIds: [1, 2, 3] }, { classId: 16, sectionIds: [1, 2, 3] }, { classId: 17, sectionIds: [1, 2, 3] }, { classId: 18, sectionIds: [1, 2, 3] }, { classId: 19, sectionIds: [1, 2, 3] }],
  '02-001503': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 16, sectionIds: [1, 2, 3] },
    { classId: 17, sectionIds: [1, 2, 3] },
  ],
  '02-001388': [
    { classId: 18, sectionIds: [1, 2, 3] },
    { classId: 19, sectionIds: [1, 2, 3] },
  ],
  '02-001339': [
    { classId: 15, sectionIds: [1, 2, 3] },
    { classId: 16, sectionIds: [1, 2, 3] },
    { classId: 17, sectionIds: [1, 2, 3] },
    { classId: 18, sectionIds: [1, 2, 3] },
  ],
  '05-00031': [
    { classId: 17, sectionIds: [1, 2, 3] },
    { classId: 18, sectionIds: [1, 2, 3] },
  ],

  // Juniors — Jr I & II
  '02-001405': [{ classId: 4, sectionIds: [1] }],
  '02-001491': [{ classId: 4, sectionIds: [2] }],
  '02-001439': [{ classId: 4, sectionIds: [3] }],
  '02-001497': [{ classId: 4, sectionIds: [4] }],
  '02-001496': [{ classId: 5, sectionIds: [1] }],
  '02-001512': [{ classId: 5, sectionIds: [4] }],
  '02-001414': [{ classId: 5, sectionIds: [2] }],
  '02-001406': [{ classId: 5, sectionIds: [3] }],
  '02-001197': [{ classId: 4, sectionIds: [1, 2, 3, 4] }],
  '02-001355': [{ classId: 5, sectionIds: [1, 2, 3, 4] }],
  '02-001486': [
    { classId: 4, sectionIds: [1, 2, 3, 4] },
    { classId: 5, sectionIds: [1, 2, 3, 4] },
  ],
  '02-001500': [
    { classId: 6, sectionIds: [1, 2, 3, 4] },
    { classId: 7, sectionIds: [1, 2, 3, 4] },
    { classId: 8, sectionIds: [1, 2, 3, 4] },
  ],

  // Juniors — Jr III–V + PDF
  '02-001424': [{ classId: 6, sectionIds: [1, 2, 3, 4] }],
  '02-001352': [{ classId: 7, sectionIds: [1, 2, 3, 4] }, { classId: 8, sectionIds: [2] }],
  '02-001420': [{ classId: 8, sectionIds: [1, 2, 3, 4] }],
  '02-001248': [
    { classId: 6, sectionIds: [1, 2, 3, 4] },
    { classId: 7, sectionIds: [1, 2, 3, 4] },
    { classId: 8, sectionIds: [1, 2, 3, 4] },
  ],
  '02-001219': [{ classId: 6, sectionIds: [1, 2, 3, 4] }],
  '02-001383': [{ classId: 7, sectionIds: [1, 2, 3, 4] }],
  '02-001407': [{ classId: 8, sectionIds: [1, 2, 3, 4] }],
  '02-001365': [
    { classId: 4, sectionIds: [1, 2, 3, 4] },
    { classId: 5, sectionIds: [1, 2, 3, 4] },
    { classId: 6, sectionIds: [1, 2, 3, 4] },
    { classId: 7, sectionIds: [1, 2, 3, 4] },
    { classId: 8, sectionIds: [1, 2, 3, 4] },
  ],
  '02-001337': [
    { classId: 4, sectionIds: [1, 2, 3, 4] },
    { classId: 5, sectionIds: [1, 2, 3, 4] },
    { classId: 6, sectionIds: [1, 2, 3, 4] },
    { classId: 7, sectionIds: [1, 2, 3, 4] },
  ],
  '02-001514': [
    { classId: 6, sectionIds: [1, 2, 3] },
    { classId: 7, sectionIds: [3] },
    { classId: 8, sectionIds: [1, 2, 3] },
  ],
  '02-001515': [{ classId: 7, sectionIds: [1, 2] }, { classId: 8, sectionIds: [1, 2, 3] }],
  '02-001516': [
    { classId: 6, sectionIds: [1, 2, 3, 4] },
    { classId: 7, sectionIds: [1, 2, 3, 4] },
    { classId: 8, sectionIds: [1, 2, 3, 4] },
  ],
  '02-001517': [
    { classId: 4, sectionIds: [1, 2, 3, 4] },
    { classId: 5, sectionIds: [1, 2, 3, 4] },
    { classId: 6, sectionIds: [1, 2, 3, 4] },
    { classId: 7, sectionIds: [1, 2, 3, 4] },
    { classId: 8, sectionIds: [1, 2, 3, 4] },
  ],
  '02-001507': [
    { classId: 4, sectionIds: [1, 2, 3, 4] },
    { classId: 5, sectionIds: [1, 2, 3, 4] },
    { classId: 6, sectionIds: [1, 2, 3, 4] },
    { classId: 7, sectionIds: [1, 2, 3, 4] },
    { classId: 8, sectionIds: [1, 2, 3, 4] },
  ],
  '02-001375': [
    { classId: 4, sectionIds: [1, 2, 3, 4] },
    { classId: 5, sectionIds: [1, 2, 3, 4] },
    { classId: 6, sectionIds: [1, 2, 3, 4] },
    { classId: 7, sectionIds: [1, 2, 3, 4] },
    { classId: 8, sectionIds: [1, 2, 3, 4] },
  ],
  '02-001376': [
    { classId: 4, sectionIds: [1, 2, 3, 4] },
    { classId: 5, sectionIds: [1, 2, 3, 4] },
    { classId: 6, sectionIds: [1, 2, 3, 4] },
    { classId: 7, sectionIds: [1, 2, 3, 4] },
    { classId: 8, sectionIds: [1, 2, 3, 4] },
  ],

  // Seniors (Johar)
  '02-001505': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
  ],
  '02-001338': [
    { classId: 11, sectionIds: [1, 2, 3] },
    { classId: 12, sectionIds: [1, 2, 3] },
    { classId: 13, sectionIds: [1, 2, 3] },
  ],
  '02-0593': [
    { classId: 10, sectionIds: [1, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
  ],
  '02-001427': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
  ],
  '02-0635': [
    { classId: 11, sectionIds: [1, 2, 3] },
    { classId: 12, sectionIds: [1, 2, 3] },
    { classId: 13, sectionIds: [1, 2, 3] },
  ],
  '02-001348': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
    { classId: 12, sectionIds: [1, 2, 3] },
    { classId: 13, sectionIds: [1, 2, 3] },
  ],
  '02-001502': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
  ],
  '02-001475': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
  ],
  '02-001271': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
  ],
  '02-001435': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
  ],
  '02-001494': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
    { classId: 12, sectionIds: [1, 2, 3] },
    { classId: 13, sectionIds: [1, 2, 3] },
  ],

  // GKF
  '02-00019': [{ classId: 1, sectionIds: [1, 2, 3] }],
  '02-00021': [{ classId: 1, sectionIds: [1, 2, 3] }],
  '02-00020': [{ classId: 2, sectionIds: [1] }],
  '02-00025': [{ classId: 2, sectionIds: [2] }],
  '02-00010': [{ classId: 2, sectionIds: [2] }],
  '02-00011': [{ classId: 3, sectionIds: [1, 2, 3] }],
  '02-00023': [{ classId: 4, sectionIds: [1, 2, 3] }],
  '02-00027': [{ classId: 5, sectionIds: [1, 2, 3] }],
  '02-00018': [
    { classId: 6, sectionIds: [1, 2, 3] },
    { classId: 7, sectionIds: [1, 2, 3] },
  ],
  '02-00015': [
    { classId: 6, sectionIds: [1, 2, 3] },
    { classId: 7, sectionIds: [1, 2, 3] },
    { classId: 8, sectionIds: [1, 2, 3] },
  ],
  '02-00028': [
    { classId: 4, sectionIds: [1, 2, 3] },
    { classId: 5, sectionIds: [1, 2, 3] },
    { classId: 6, sectionIds: [1, 2, 3] },
    { classId: 7, sectionIds: [1, 2, 3] },
  ],

  // North Nazimabad
  '02-0067': [
    { classId: 1, sectionIds: [1, 2, 3] },
    { classId: 2, sectionIds: [1, 2, 3] },
  ],
  '02-0071': [{ classId: 3, sectionIds: [1, 2, 3] }],
  '02-0066': [{ classId: 4, sectionIds: [1, 2, 3] }],
  '02-0055': [{ classId: 5, sectionIds: [1, 2, 3] }],
  '02-0070': [
    { classId: 6, sectionIds: [1, 2, 3] },
    { classId: 7, sectionIds: [1, 2, 3] },
    { classId: 8, sectionIds: [1, 2, 3] },
  ],
  '02-0072': [
    { classId: 6, sectionIds: [1, 2, 3] },
    { classId: 7, sectionIds: [1, 2, 3] },
    { classId: 8, sectionIds: [1, 2, 3] },
  ],
  '02-0053': [
    { classId: 6, sectionIds: [1, 2, 3] },
    { classId: 7, sectionIds: [1, 2, 3] },
    { classId: 8, sectionIds: [1, 2, 3] },
  ],
};

/** Non-classroom roles — class-section left blank by design, not a review flag. */
export const NO_CLASS_ASSIGNMENT_EXPECTED = new Set([
  '03-00557',
  '03-00608',
  '02-001413',
  '03-00451',
  '03-1937',
  '03-00639',
  '01-00018',
  '03-00325',
  '02-00836',
  '02-001231',
  '02-0924',
  '02-001214',
  '01-2000',
  '01-00019',
  '01-2006',
  '01-00017',
  '01-2009',
  '03-00174',
  '03-00125',
  '03-00489',
  '03-00331',
  '03-00190',
  '03-00237',
  '03-00591',
  '03-00612',
  '03-00318',
  '03-00636',
  '03-00643',
  '03-00644',
  '01-2005',
  '03-00556',
  '03-00486',
  '03-00580',
  '03-00547',
  '03-00603',
  '03-00615',
  '02-001502', // legacy Uzma code — now has assignments
  '02-001518', // Sir Shariq — Robotics, no class assignment
]);

export function normEmployeeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function getManualClassSectionOverride(code: string): ClassSectionAssignment[] | null {
  const norm = normEmployeeCode(code);
  if (MANUAL_CLASS_SECTION_OVERRIDES[norm]) {
    return MANUAL_CLASS_SECTION_OVERRIDES[norm];
  }
  const parsed = norm.match(/^[A-Z]+-(\d{2}-\d+)$/);
  if (parsed && MANUAL_CLASS_SECTION_OVERRIDES[parsed[1]]) {
    return MANUAL_CLASS_SECTION_OVERRIDES[parsed[1]];
  }
  return null;
}

export function isNoClassAssignmentExpected(code: string): boolean {
  const norm = normEmployeeCode(code);
  if (NO_CLASS_ASSIGNMENT_EXPECTED.has(norm)) return true;
  const parsed = norm.match(/^[A-Z]+-(\d{2}-\d+)$/);
  if (parsed && NO_CLASS_ASSIGNMENT_EXPECTED.has(parsed[1])) return true;
  return false;
}
