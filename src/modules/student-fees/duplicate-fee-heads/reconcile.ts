/**
 * TAFSD-546. The Fee Heads report's own totals and reconciliation check, for
 * the cleanup to run before and after. Uses FinancialReportsService's private
 * feeHeadMoneyTotals / buildTotalsCheck on purpose: a second copy of the
 * report's arithmetic here could agree with itself and disagree with the
 * report. Both only read through prisma.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { FinancialReportsService } from '../../financial-reports/financial-reports.service';

export interface FeeHeadTotals {
  count: number;
  billed: number;
  to_be_billed: number;
  waived: number;
  amount: number;
  amount_paid: number;
  outstanding: number;
}

export interface FeeHeadCheck {
  totals: FeeHeadTotals;
  reconciles: boolean;
  billed_plus_to_be_billed: boolean;
  paid_plus_outstanding: boolean;
}

export async function feeHeadsCheck(
  prisma: PrismaClient,
  where: Prisma.student_feesWhereInput = {},
): Promise<FeeHeadCheck> {
  const svc = new FinancialReportsService(
    prisma as any,
    null as any,
    null as any,
  ) as any;
  // Same leaf filter as the report (feeHeadsLeafWhere) with no date range.
  const totals = await svc.feeHeadMoneyTotals({
    is_arrear_surcharge: false,
    ...where,
  });
  const check = svc.buildTotalsCheck(totals);
  return {
    totals: {
      count: totals.count,
      billed: totals.billed,
      to_be_billed: totals.to_be_billed,
      waived: totals.waived,
      amount: totals.amount,
      amount_paid: totals.amount_paid,
      outstanding: totals.outstanding,
    },
    reconciles: check.reconciles,
    billed_plus_to_be_billed: check.billed_plus_to_be_billed,
    paid_plus_outstanding: check.paid_plus_outstanding,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * After removing only NOT_ISSUED, unpaid heads, amount and to_be_billed must
 * each fall by exactly the removed sum and nothing else may move. Returns the
 * list of differences from that expectation (empty = as expected).
 */
export function expectedDelta(
  before: FeeHeadTotals,
  after: FeeHeadTotals,
  removedSum: number,
  removedCount: number,
): string[] {
  const problems: string[] = [];
  const want: FeeHeadTotals = {
    count: before.count - removedCount,
    billed: before.billed,
    to_be_billed: r2(before.to_be_billed - removedSum),
    waived: before.waived,
    amount: r2(before.amount - removedSum),
    amount_paid: before.amount_paid,
    outstanding: r2(before.outstanding - removedSum),
  };
  for (const k of Object.keys(want) as (keyof FeeHeadTotals)[]) {
    if (r2(after[k]) !== r2(want[k]))
      problems.push(`${k}: expected ${want[k]}, got ${after[k]}`);
  }
  return problems;
}
