/**
 * TAFSD-475: the five seeded special categories, and a way to turn a spec's
 * old-style student row (is_fee_endowment, fee_endowment_until, …) into the
 * `student_category_assignments` shape BENEFIT_SELECT now loads.
 */
export const SEED_CATEGORIES = [
  { id: 1, code: 'FEE_ENDOWMENT', label: 'Fee Endowment', description: 'Everything waived', tone: 'amber', display_order: 10, is_active: true },
  { id: 2, code: 'FEE_ENDOWMENT_MTF', label: 'Fee Endowment (Monthly Tuition Fee)', description: null, tone: 'orange', display_order: 20, is_active: true },
  { id: 3, code: 'COMPLEMENTARY', label: 'Complementary', description: 'Everything waived', tone: 'emerald', display_order: 30, is_active: true },
  { id: 4, code: 'SEHM_E_SADAAT', label: 'Sehm-e-Sadaat', description: null, tone: 'sky', display_order: 40, is_active: true },
  { id: 5, code: 'SEHM_E_IMAM', label: 'Sehm-e-Imam', description: null, tone: 'violet', display_order: 50, is_active: true },
];

/** Moves legacy is_<x> / <x>_reason / _until / _remind_from keys into assignments. */
export function withCategoryAssignments<T extends Record<string, any>>(r: T): T {
  const out: Record<string, any> = { ...r };
  const assignments: any[] = [];
  for (const c of SEED_CATEGORIES) {
    const p = c.code.toLowerCase();
    if (out[`is_${p}`])
      assignments.push({
        reason: out[`${p}_reason`] ?? null,
        until: out[`${p}_until`] ?? null,
        remind_from: out[`${p}_remind_from`] ?? null,
        student_categories: { code: c.code, label: c.label, display_order: c.display_order },
      });
    for (const k of [`is_${p}`, `${p}_reason`, `${p}_until`, `${p}_remind_from`]) delete out[k];
  }
  out.student_category_assignments = assignments;
  return out as T;
}
