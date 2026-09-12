import { ScopeDimension } from '@prisma/client';

/**
 * A user's universal data scope — "which records may this person touch".
 *
 * An EMPTY array on a dimension means UNRESTRICTED on that dimension, not
 * "nothing". Non-empty dimensions AND together: a record must match every
 * dimension the user has entries for.
 *
 * Note the consequence of AND-ing on a nullable column: a user scoped to
 * campus [1] does NOT see records whose campus_id is null, because an
 * unassigned record is not in anyone's scope. That is deliberate — it keeps
 * half-configured rows out of scoped users' lists rather than leaking them to
 * everyone.
 */
export type UserScope = {
  campuses: number[];
  segments: number[];
  classes: number[];
  sections: number[];
  departments: number[];
  staffCategories: number[];
};

export const EMPTY_SCOPE: UserScope = Object.freeze({
  campuses: [],
  segments: [],
  classes: [],
  sections: [],
  departments: [],
  staffCategories: [],
});

/** Maps a scope field onto its persisted ScopeDimension enum value. */
export const SCOPE_FIELD_BY_DIMENSION: Record<ScopeDimension, keyof UserScope> = {
  CAMPUS: 'campuses',
  SEGMENT: 'segments',
  CLASS: 'classes',
  SECTION: 'sections',
  DEPARTMENT: 'departments',
  STAFF_CATEGORY: 'staffCategories',
};

/** Human labels for error messages and the admin panel. */
export const SCOPE_DIMENSION_LABEL: Record<ScopeDimension, string> = {
  CAMPUS: 'campus',
  SEGMENT: 'segment',
  CLASS: 'class',
  SECTION: 'section',
  DEPARTMENT: 'department',
  STAFF_CATEGORY: 'staff category',
};

export function scopeFromEntries(
  entries: { dimension: ScopeDimension; ref_id: number }[],
): UserScope {
  const scope: UserScope = {
    campuses: [],
    segments: [],
    classes: [],
    sections: [],
    departments: [],
    staffCategories: [],
  };
  for (const entry of entries) {
    scope[SCOPE_FIELD_BY_DIMENSION[entry.dimension]].push(entry.ref_id);
  }
  return scope;
}

/** True when the dimension places no restriction on this user. */
export function isUnrestricted(scope: UserScope, field: keyof UserScope): boolean {
  return scope[field].length === 0;
}

/** True when `id` is inside the user's scope for that dimension. */
export function scopeAllows(
  scope: UserScope,
  field: keyof UserScope,
  id: number | null | undefined,
): boolean {
  if (isUnrestricted(scope, field)) return true;
  if (id == null) return false;
  return scope[field].includes(id);
}

/** True when the user has no restriction on any dimension. */
export function isFullyUnrestricted(scope: UserScope): boolean {
  return (Object.keys(scope) as (keyof UserScope)[]).every((f) => isUnrestricted(scope, f));
}

type IdFilter = { in: number[] };

function maybeIn(values: number[]): IdFilter | undefined {
  return values.length > 0 ? { in: values } : undefined;
}

/** Drops keys whose value is undefined so the fragment stays a clean Prisma where. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * Prisma `where` fragment scoping a query over `employee_profiles`.
 *
 * CLASS and SECTION are deliberately NOT applied here: an employee's link to a
 * class is an assignment (`employee_class_section_assignments`), not an
 * attribute, and treating it as scope would hide every non-teaching employee
 * from a class-scoped user. See the handoff before changing this.
 */
export function whereForEmployees(scope: UserScope) {
  return compact({
    campus_id: maybeIn(scope.campuses),
    segment_id: maybeIn(scope.segments),
    department_id: maybeIn(scope.departments),
    staff_category_id: maybeIn(scope.staffCategories),
  });
}

/**
 * Prisma `where` fragment scoping a query over `students`.
 * SEGMENT is applied through the student's class, which carries `segment_id`.
 */
export function whereForStudents(scope: UserScope) {
  return compact({
    campus_id: maybeIn(scope.campuses),
    class_id: maybeIn(scope.classes),
    section_id: maybeIn(scope.sections),
    classes: scope.segments.length > 0 ? { segment_id: { in: scope.segments } } : undefined,
  });
}
