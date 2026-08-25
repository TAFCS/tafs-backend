import { Prisma } from '@prisma/client';

/**
 * Builds the students-table WHERE fragment for "graduated in academic year
 * range YYYY-YYYY", e.g. "2025-2026".
 *
 * The calendar window a given range maps to depends on the term system of the
 * class the student graduated from: Apr-Mar for term_start_month = 4 (see
 * academic-labels.ts), Aug-Jul otherwise — including students with no
 * graduated_from_class at all. Returns null for an unparseable/absent range.
 */
export function buildGraduatedYearRangeWhere(
  yearRange?: string | null,
): Prisma.studentsWhereInput | null {
  if (!yearRange) return null;
  const startYear = Number(yearRange.split('-')[0]);
  if (!Number.isFinite(startYear)) return null;

  const aprMarStart = new Date(Date.UTC(startYear, 3, 1));
  const aprMarEnd = new Date(Date.UTC(startYear + 1, 2, 31, 23, 59, 59, 999));
  const augJulStart = new Date(Date.UTC(startYear, 7, 1));
  const augJulEnd = new Date(Date.UTC(startYear + 1, 6, 31, 23, 59, 59, 999));

  return {
    OR: [
      {
        graduated_from_class: { term_start_month: 4 },
        graduated_at: { gte: aprMarStart, lte: aprMarEnd },
      },
      {
        OR: [
          { graduated_from_class_id: null },
          { graduated_from_class: { term_start_month: { not: 4 } } },
        ],
        graduated_at: { gte: augJulStart, lte: augJulEnd },
      },
    ],
  };
}

/**
 * Combines a `graduated_from_class_id` filter and/or a graduation year range
 * into an AND-able WHERE fragment, pinned to graduated_at not being null.
 *
 * That pin matters because reinstating a graduated student (POST
 * /students/:id/return) clears graduated_at but leaves graduated_from_class_id
 * in place as a restore hint — without it, a currently-ENROLLED reinstated
 * student would still match a "graduated from X" filter on their stale value.
 */
export function buildGraduationFilterWhere(
  graduatedFromClassIds?: number[] | null,
  yearRange?: string | null,
): Prisma.studentsWhereInput[] {
  const conditions: Prisma.studentsWhereInput[] = [];
  if (graduatedFromClassIds?.length) {
    conditions.push({ graduated_from_class_id: { in: graduatedFromClassIds } });
  }
  const yearRangeWhere = buildGraduatedYearRangeWhere(yearRange);
  if (yearRangeWhere) conditions.push(yearRangeWhere);
  if (conditions.length) conditions.push({ graduated_at: { not: null } });
  return conditions;
}
