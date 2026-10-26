/**
 * School heading rules by class:
 * - Classes VI–X (classes.id 15–19) → "THE AMERICAN FOUNDATION SCHOOL FOR SECONDARY STUDIES"
 * - A Level (classes.id 20–21, AS/A2) → "THE AMERICAN FOUNDATION SCHOOL FOR A LEVEL STUDIES"
 * - The rest → "THE AMERICAN FOUNDATION SCHOOL"
 */

export const SCHOOL_NAME = 'THE AMERICAN FOUNDATION SCHOOL';
export const SCHOOL_NAME_SECONDARY = `${SCHOOL_NAME} FOR SECONDARY STUDIES`;
export const SCHOOL_NAME_A_LEVEL = `${SCHOOL_NAME} FOR A LEVEL STUDIES`;

/** `classes.id` 15–19 — VI, VII, VIII, IX, X */
export const SECONDARY_CLASS_IDS = new Set([15, 16, 17, 18, 19]);

/** `classes.id` 20–21 — AS, A2 */
export const A_LEVEL_CLASS_IDS = new Set([20, 21]);

export function isSecondaryClass(
  classId?: number | null,
  className?: string | null,
  classCode?: string | null,
): boolean {
  if (classId != null && SECONDARY_CLASS_IDS.has(classId)) return true;
  const normalized = (classCode || className || '').trim().toUpperCase();
  return /^(CLASS\s+)?(VI|VII|VIII|IX|X)$/i.test(normalized) || /\b(CLASS\s+)?(VI|VII|VIII|IX|X)\b/i.test(normalized);
}

export function isALevelClass(
  classId?: number | null,
  className?: string | null,
  classCode?: string | null,
  system?: string | null,
): boolean {
  if (classId != null && A_LEVEL_CLASS_IDS.has(classId)) return true;
  const sys = (system || '').trim().toUpperCase();
  if (sys.includes('A LEVEL') || sys.includes('A-LEVEL')) return true;
  const normalized = (classCode || className || '').trim().toUpperCase();
  return /^(AS|A2|A-LEVEL|A LEVEL)(\s+LEVEL)?$/i.test(normalized) || /\b(AS|A2)\b/i.test(normalized);
}

export function schoolHeadingForClass(params: {
  class_id?: number | null;
  class_name?: string | null;
  class_code?: string | null;
  academic_system?: string | null;
}): string {
  if (isSecondaryClass(params.class_id, params.class_name, params.class_code)) {
    return SCHOOL_NAME_SECONDARY;
  }
  if (isALevelClass(params.class_id, params.class_name, params.class_code, params.academic_system)) {
    return SCHOOL_NAME_A_LEVEL;
  }
  return SCHOOL_NAME;
}
