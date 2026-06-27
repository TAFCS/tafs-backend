/**
 * Manual class-section assignments and no-assignment flags from staff_mapping_review.txt.
 * Used when CSV values cannot be auto-parsed or duplicate Staff Type text.
 */

export interface ClassSectionAssignment {
  classId: number;
  sectionIds: number[];
}

/** Reviewed overrides keyed by employee_code (case-insensitive lookup via normCode). */
export const MANUAL_CLASS_SECTION_OVERRIDES: Record<string, ClassSectionAssignment[]> = {
  '02-0861': [
    { classId: 1, sectionIds: [1, 2, 3] },
    { classId: 3, sectionIds: [1, 2, 3] },
  ],
  '02-0635': [
    { classId: 11, sectionIds: [1, 2, 3] },
    { classId: 12, sectionIds: [1, 2, 3] },
    { classId: 13, sectionIds: [1, 2, 3] },
  ],
  '02-0593': [
    { classId: 10, sectionIds: [1, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
  ],
  '02-001271': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
  ],
  '02-001273': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [2] },
  ],
  '02-001338': [
    { classId: 11, sectionIds: [1, 2, 3] },
    { classId: 12, sectionIds: [1, 2, 3] },
    { classId: 13, sectionIds: [1, 2, 3] },
  ],
  '02-001435': [
    { classId: 10, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
  ],
  '02-001348': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
    { classId: 12, sectionIds: [1, 2, 3] },
    { classId: 13, sectionIds: [1, 2, 3] },
  ],
  '02-001427': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
  ],
  '02-001468': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
  ],
  '02-001475': [
    { classId: 9, sectionIds: [1, 2, 3] },
    { classId: 10, sectionIds: [1, 2, 3] },
    { classId: 11, sectionIds: [1, 2, 3] },
  ],
  '02-00644': [
    { classId: 15, sectionIds: [1, 2, 3] },
    { classId: 16, sectionIds: [1, 2, 3] },
    { classId: 17, sectionIds: [1, 2, 3] },
  ],
  '02-001138': [
    { classId: 15, sectionIds: [1, 2, 3] },
    { classId: 16, sectionIds: [1, 2, 3] },
    { classId: 17, sectionIds: [1, 2, 3] },
    { classId: 18, sectionIds: [1, 2, 3] },
    { classId: 19, sectionIds: [1, 2, 3] },
  ],
  '02-001339': [
    { classId: 15, sectionIds: [1, 2, 3] },
    { classId: 16, sectionIds: [1, 2, 3] },
    { classId: 17, sectionIds: [1, 2, 3] },
    { classId: 18, sectionIds: [1, 2, 3] },
    { classId: 19, sectionIds: [1, 2, 3] },
  ],
  '02-001359': [
    { classId: 15, sectionIds: [1, 2, 3] },
    { classId: 16, sectionIds: [1, 2, 3] },
    { classId: 17, sectionIds: [1, 2, 3] },
    { classId: 18, sectionIds: [1, 2, 3] },
    { classId: 19, sectionIds: [1, 2, 3] },
  ],
  '02-001388': [
    { classId: 18, sectionIds: [1, 2, 3] },
    { classId: 19, sectionIds: [1, 2, 3] },
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
]);

export function normEmployeeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function getManualClassSectionOverride(code: string): ClassSectionAssignment[] | null {
  return MANUAL_CLASS_SECTION_OVERRIDES[normEmployeeCode(code)] ?? null;
}

export function isNoClassAssignmentExpected(code: string): boolean {
  return NO_CLASS_ASSIGNMENT_EXPECTED.has(normEmployeeCode(code));
}
