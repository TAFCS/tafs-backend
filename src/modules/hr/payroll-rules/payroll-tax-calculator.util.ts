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
