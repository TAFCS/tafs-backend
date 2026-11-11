/**
 * TAFSD-475: special categories (Fee Endowment, Complementary, Sehm-e-Sadaat, …)
 * live in `student_categories`, managed in School Setup, and a student's
 * categories in `student_category_assignments` (reason, end date, and the date
 * the home reminder starts). Labels are always the full names, never FE / COMP.
 *
 * Before TAFSD-475 these were five hard-coded column groups on `students`
 * (is_<x>, <x>_reason, <x>_until, <x>_remind_from). Those columns are no longer
 * read or written. API responses still carry the same flat keys for every
 * category a student holds (`is_<code lowercase>` …), next to `categories`.
 */
import type { Prisma } from '@prisma/client';

/** A category from School Setup. `key` is its fixed code, e.g. FEE_ENDOWMENT. */
export interface StudentCategoryRef {
  id: number;
  key: string;
  label: string;
  description: string | null;
  tone: string;
  order: number;
  is_active: boolean;
}

/** A category a student holds. Dates are YYYY-MM-DD. */
export interface StudentBenefitDetail {
  key: string;
  label: string;
  order: number;
  reason: string | null;
  until: string | null;
  remind_from: string | null;
}

/** The categories the five legacy columns used to hold, by their codes. */
export const LEGACY_CATEGORY_CODES = [
  'FEE_ENDOWMENT',
  'FEE_ENDOWMENT_MTF',
  'COMPLEMENTARY',
  'SEHM_E_SADAAT',
  'SEHM_E_IMAM',
] as const;

/** The flat key prefix a category's code maps to: FEE_ENDOWMENT → fee_endowment. */
export const categoryPrefix = (code: string) => code.toLowerCase();

/** For Prisma `select` on students: the student's categories. */
export const BENEFIT_SELECT = {
  student_category_assignments: {
    select: {
      reason: true,
      until: true,
      remind_from: true,
      student_categories: {
        select: { code: true, label: true, display_order: true },
      },
    },
  },
} satisfies Prisma.studentsSelect;

const day = (d: unknown): string | null =>
  d ? new Date(d as string | Date).toISOString().slice(0, 10) : null;

/** A student row's categories (selected with BENEFIT_SELECT), in School Setup order. */
export function studentBenefits(s: Record<string, any>): StudentBenefitDetail[] {
  const rows: any[] = s?.student_category_assignments ?? [];
  return rows
    .map((a) => ({
      key: a.student_categories.code as string,
      label: a.student_categories.label as string,
      order: Number(a.student_categories.display_order ?? 0),
      reason: a.reason ?? null,
      until: day(a.until),
      remind_from: day(a.remind_from),
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/**
 * The categories of a student row for API responses: `categories`, plus the
 * flat keys older screens read (`is_fee_endowment`, `fee_endowment_until`, …)
 * for each category held. The five legacy flags are always present.
 */
export function flattenBenefits(s: Record<string, any>) {
  const categories = studentBenefits(s);
  const out: Record<string, unknown> = {};
  for (const code of LEGACY_CATEGORY_CODES) out[`is_${categoryPrefix(code)}`] = false;
  for (const c of categories) {
    const p = categoryPrefix(c.key);
    out[`is_${p}`] = true;
    out[`${p}_reason`] = c.reason;
    out[`${p}_until`] = c.until;
    out[`${p}_remind_from`] = c.remind_from;
  }
  out.categories = categories;
  return out;
}

/**
 * A category counts on `today` (YYYY-MM-DD) when its end date, if any, has not
 * passed.
 */
export const benefitActive = (b: Pick<StudentBenefitDetail, 'until'>, today: string) =>
  !b.until || b.until >= today;

/** Every category, in School Setup order. Retired ones only when asked. */
export async function loadStudentCategories(
  prisma: { student_categories: { findMany: (args: any) => Promise<any[]> } },
  opts: { includeRetired?: boolean } = {},
): Promise<StudentCategoryRef[]> {
  const rows = await prisma.student_categories.findMany({
    where: opts.includeRetired ? {} : { is_active: true },
    orderBy: [{ display_order: 'asc' }, { label: 'asc' }],
  });
  return rows.map(toCategoryRef);
}

export function toCategoryRef(r: any): StudentCategoryRef {
  return {
    id: r.id,
    key: r.code,
    label: r.label,
    description: r.description ?? null,
    tone: r.tone,
    order: r.display_order,
    is_active: r.is_active,
  };
}

/** Prisma `where` on students: holds the category with this code (any end date). */
export const holdsCategory = (code: string): Prisma.studentsWhereInput => ({
  student_category_assignments: { some: { student_categories: { code } } },
});

/** Prisma `where` on students: true → holds it, false → doesn't. */
export const categoryFlagWhere = (
  code: string,
  on: boolean,
): Prisma.studentsWhereInput =>
  on
    ? holdsCategory(code)
    : { student_category_assignments: { none: { student_categories: { code } } } };
