/**
 * TAFSD-455: the fee benefit categories a student can hold. Each one is a
 * yes/no column plus `<prefix>_reason`, `<prefix>_until` (end date) and
 * `<prefix>_remind_from` (when the home reminder starts). Labels are always
 * the full names, never FE / COMP / SES / SEI.
 */
export const STUDENT_BENEFITS = [
  { key: 'FEE_ENDOWMENT', label: 'Fee Endowment', flag: 'is_fee_endowment', prefix: 'fee_endowment' },
  {
    key: 'FEE_ENDOWMENT_MTF',
    label: 'Fee Endowment (Monthly Tuition Fee)',
    flag: 'is_fee_endowment_mtf',
    prefix: 'fee_endowment_mtf',
  },
  { key: 'COMPLEMENTARY', label: 'Complementary', flag: 'is_complementary', prefix: 'complementary' },
  { key: 'SEHM_E_SADAAT', label: 'Sehm-e-Sadaat', flag: 'is_sehm_e_sadaat', prefix: 'sehm_e_sadaat' },
  { key: 'SEHM_E_IMAM', label: 'Sehm-e-Imam', flag: 'is_sehm_e_imam', prefix: 'sehm_e_imam' },
] as const;

export type StudentBenefit = (typeof STUDENT_BENEFITS)[number];
export type StudentBenefitKey = StudentBenefit['key'];
export const STUDENT_BENEFIT_KEYS = STUDENT_BENEFITS.map((b) => b.key);

export const benefitFields = (b: StudentBenefit) => ({
  flag: b.flag,
  reason: `${b.prefix}_reason` as const,
  until: `${b.prefix}_until` as const,
  remindFrom: `${b.prefix}_remind_from` as const,
});

/** Every benefit column, for Prisma `select`. */
export const BENEFIT_SELECT = Object.fromEntries(
  STUDENT_BENEFITS.flatMap((b) => Object.values(benefitFields(b)).map((f) => [f, true])),
) as Record<string, true>;

/** Columns holding dates (end and reminder), for parsing and audit diffs. */
export const BENEFIT_DATE_FIELDS = STUDENT_BENEFITS.flatMap((b) => {
  const f = benefitFields(b);
  return [f.until, f.remindFrom];
});

/** Every benefit column name, for the audit-tracked field list. */
export const BENEFIT_FIELD_NAMES = Object.keys(BENEFIT_SELECT);

const day = (d: unknown): string | null =>
  d ? new Date(d as string | Date).toISOString().slice(0, 10) : null;

/** The benefit columns of a student row, with dates as YYYY-MM-DD. */
export function flattenBenefits(s: Record<string, any>) {
  const out: Record<string, boolean | string | null> = {};
  for (const b of STUDENT_BENEFITS) {
    const f = benefitFields(b);
    out[f.flag] = !!s[f.flag];
    out[f.reason] = s[f.reason] ?? null;
    out[f.until] = day(s[f.until]);
    out[f.remindFrom] = day(s[f.remindFrom]);
  }
  return out;
}

/**
 * A benefit counts on `today` (YYYY-MM-DD) when it is switched on and its end
 * date, if any, has not passed.
 */
export function benefitActive(
  s: Record<string, any>,
  b: StudentBenefit,
  today: string,
): boolean {
  const f = benefitFields(b);
  if (!s[f.flag]) return false;
  const until = day(s[f.until]);
  return !until || until >= today;
}
