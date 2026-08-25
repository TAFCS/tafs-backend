import { Prisma } from '@prisma/client';

/**
 * Combines a `graduated_from_class_id` filter and/or a graduation academic-year
 * filter into an AND-able WHERE fragment, pinned to graduated_at not being null.
 *
 * The year filter is a plain equality check against `graduated_academic_year`,
 * captured at write time (or chosen by staff) as the academic year a student
 * was studying in when they graduated. No date math or classes.term_start_month
 * join needed at read time — this sidesteps the UTC/Asia-Karachi timezone edge
 * case a date-derived "graduated in year X" check was exposed to.
 *
 * The graduated_at pin matters because reinstating a graduated student (POST
 * /students/:id/return) clears graduated_at (and graduated_academic_year) but
 * leaves graduated_from_class_id in place as a restore hint — without the pin,
 * a currently-ENROLLED reinstated student would still match a "graduated from
 * X" filter on their stale value.
 */
export function buildGraduationFilterWhere(
  graduatedFromClassIds?: number[] | null,
  yearRange?: string | null,
): Prisma.studentsWhereInput[] {
  const conditions: Prisma.studentsWhereInput[] = [];
  if (graduatedFromClassIds?.length) {
    conditions.push({ graduated_from_class_id: { in: graduatedFromClassIds } });
  }
  if (yearRange) {
    conditions.push({ graduated_academic_year: yearRange });
  }
  if (conditions.length) conditions.push({ graduated_at: { not: null } });
  return conditions;
}
