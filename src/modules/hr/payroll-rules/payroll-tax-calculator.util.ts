import { Prisma } from '@prisma/client';

interface IncomeTaxSlab {
  min: number;
  max: number | null;
  fixed_amount: number;
  rate_percent: number;
}

export function calculateStatutoryContribution(wageBase: number, percent: number): Prisma.Decimal {
  return new Prisma.Decimal(wageBase).times(percent).dividedBy(100).toDecimalPlaces(2);
}

/** FBR slab formula: fixed_amount + rate_percent% of the amount exceeding (min - 1). */
export function calculateMonthlyIncomeTax(annualIncome: number, slabs: IncomeTaxSlab[]): Prisma.Decimal {
  const slab = slabs.find((s) => annualIncome >= s.min && (s.max === null || annualIncome <= s.max));
  if (!slab) return new Prisma.Decimal(0);

  const excess = new Prisma.Decimal(annualIncome).minus(slab.min - 1);
  const annualTax = new Prisma.Decimal(slab.fixed_amount).plus(excess.times(slab.rate_percent).dividedBy(100));
  return annualTax.dividedBy(12).toDecimalPlaces(2);
}

export interface StatutoryRuleValues {
  /** null when no EOBI rule is in force for the period. */
  eobi: { employer_percent?: number; employee_percent?: number; wage_base_amount?: number } | null;
  /** null when no SESSI rule is in force for the period. */
  sessi: { employer_percent?: number; wage_base_amount?: number } | null;
}

export interface StatutoryContributions {
  eobiDeduction: Prisma.Decimal;
  eobiEmployerCost: Prisma.Decimal;
  sessiEmployerCost: Prisma.Decimal;
}

/**
 * EOBI (employee deduction + employer cost) and SESSI (employer cost) for one
 * payroll line. TAFSD-278: an exempt employee gets nothing for that scheme —
 * not a reduced amount, no amount at all, on either side.
 */
export function calculateStatutoryContributions(
  rules: StatutoryRuleValues,
  exempt: { eobi: boolean; sessi: boolean },
): StatutoryContributions {
  const zero = new Prisma.Decimal(0);
  const eobi = exempt.eobi ? null : rules.eobi;
  const sessi = exempt.sessi ? null : rules.sessi;
  return {
    eobiDeduction: eobi ? calculateStatutoryContribution(eobi.wage_base_amount ?? 0, eobi.employee_percent ?? 0) : zero,
    eobiEmployerCost: eobi ? calculateStatutoryContribution(eobi.wage_base_amount ?? 0, eobi.employer_percent ?? 0) : zero,
    sessiEmployerCost: sessi ? calculateStatutoryContribution(sessi.wage_base_amount ?? 0, sessi.employer_percent ?? 0) : zero,
  };
}
