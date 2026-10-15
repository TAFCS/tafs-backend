/**
 * Pure rules for the reporting hierarchy (TAFSD-327). No DB, unit-tested in
 * reporting-hierarchy.rules.spec.ts.
 */

export type ReportingLine = { employee_id: number; manager_id: number };

export type HierarchyPerson = {
  id: number;
  full_name: string | null;
  campus_id: number | null;
  department_id: number | null;
  /** staff_categories.code; SENIOR_LEADERSHIP managers are exempt from the fit rule. */
  category_code: string | null;
};

/** Staff in this category may manage anyone, on any campus, in any department. */
export const SENIOR_LEADERSHIP_CODE = 'SENIOR_LEADERSHIP';

export function isSeniorLeadership(p: Pick<HierarchyPerson, 'category_code'>): boolean {
  return p.category_code === SENIOR_LEADERSHIP_CODE;
}

/**
 * Below senior leadership, a manager must work in the same department on the
 * same campus as the person reporting to them. Returns the managers that break
 * that rule. A missing campus or department on either side never fits: a
 * half-configured record can't be placed until it is filled in.
 */
export function managersOutsideFit(employee: HierarchyPerson, managers: HierarchyPerson[]): HierarchyPerson[] {
  return managers.filter(
    (m) =>
      !isSeniorLeadership(m) &&
      (employee.campus_id == null ||
        employee.department_id == null ||
        m.campus_id !== employee.campus_id ||
        m.department_id !== employee.department_id),
  );
}

/** Everyone below `employeeId`, following every line (not just primary ones). */
export function descendantsOf(lines: ReportingLine[], employeeId: number): Set<number> {
  const reports = new Map<number, number[]>();
  for (const l of lines) {
    reports.set(l.manager_id, [...(reports.get(l.manager_id) ?? []), l.employee_id]);
  }
  const seen = new Set<number>();
  const stack = [...(reports.get(employeeId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(reports.get(id) ?? []));
  }
  return seen;
}

/**
 * Managers that would close a loop: anyone already below `employeeId` can't
 * also be above them. `lines` is the current hierarchy; lines out of
 * `employeeId` itself are about to be replaced, so they don't matter.
 */
export function managersThatLoop(lines: ReportingLine[], employeeId: number, managerIds: number[]): number[] {
  const below = descendantsOf(lines, employeeId);
  return managerIds.filter((id) => id === employeeId || below.has(id));
}
