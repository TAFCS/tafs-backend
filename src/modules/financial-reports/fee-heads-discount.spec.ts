import { Prisma } from '@prisma/client';
import { FinancialReportsService } from './financial-reports.service';

/**
 * Fee Heads report — discounts and "paid".
 *
 * A voucher of 100,000 with a 20,000 discount, settled by an 80,000 deposit:
 * every head is PAID, but only 80,000 was received. applyDiscountCreditInTx
 * writes the discount into the heads' amount_paid (so they can show PAID) and
 * mirrors it onto the discount row's amount_paid as "consumed". Summing the
 * heads' amount_paid alone reported 100,000 paid and -20,000 outstanding.
 */
describe('FinancialReportsService — Fee Heads discounts', () => {
  const D = (n: number) => new Prisma.Decimal(n);
  const isDiscountQuery = (args: any) => args.where?.is_discount === true;

  // Two tuition heads of 50,000 on one fee date, both PAID via 80,000 cash +
  // a 20,000 discount that has been fully consumed.
  const makePrisma = () => ({
    student_fees: {
      aggregate: jest.fn(async (args: any) =>
        isDiscountQuery(args)
          ? { _sum: { amount: D(20000), amount_paid: D(20000) }, _count: 1 }
          : { _sum: { amount: D(100000), amount_paid: D(100000) }, _count: 2 },
      ),
      groupBy: jest.fn(async (args: any) => {
        const feeDate = new Date('2026-06-01T00:00:00Z');
        if (args.by.includes('status')) {
          return isDiscountQuery(args)
            ? [{ status: 'DISCOUNT', _sum: { amount: D(20000) }, _count: { _all: 1 } }]
            : [{ status: 'PAID', _sum: { amount: D(100000) }, _count: { _all: 2 } }];
        }
        if (args.where?.status === 'WAIVED') return [];
        return isDiscountQuery(args)
          ? [{ fee_date: feeDate, _sum: { amount: D(20000), amount_paid: D(20000) }, _count: { _all: 1 } }]
          : [{ fee_date: feeDate, _sum: { amount: D(100000), amount_paid: D(100000) }, _count: { _all: 2 } }];
      }),
    },
    students: { count: jest.fn(async () => 1) },
  });

  const svc = (prisma: any) => new FinancialReportsService(prisma, { log: async () => null } as any);
  const query = { from_date: '2026-06-01', to_date: '2026-06-30', view: 'fee_date' as const };
  const user = { campusId: null } as any;

  it('reports cash only as paid, with nothing outstanding', async () => {
    const res: any = await svc(makePrisma()).listFeeHeads(query, user);
    expect(res.totals.amount).toBe(80000);
    expect(res.totals.amount_paid).toBe(80000);
    expect(res.totals.outstanding).toBe(0);
    expect(res.totals.reconciles).toBe(true);
  });

  it('"By fee date" shows the discount next to the heads billed on that date', async () => {
    const res: any = await svc(makePrisma()).listFeeHeads(query, user);
    expect(res.view).toBe('fee_date');
    expect(res.items).toEqual([
      {
        fee_date: '2026-06-01',
        head_count: 2,
        discount_count: 1,
        billed: 100000,
        discount: -20000,
        amount: 80000,
        amount_paid: 80000,
        waived: 0,
        outstanding: 0,
      },
    ]);
  });
});
