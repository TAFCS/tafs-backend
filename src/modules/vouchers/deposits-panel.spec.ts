// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { VouchersService } from './vouchers.service';

/**
 * The voucher-PDF "PAYMENT HISTORY (LAST 3 PAYMENTS)" sidebar panel
 * (buildDepositsPanel): one row per actual deposit, newest three, oldest-first,
 * with a running "TOTAL DEPOSITED", an informational green sub-row for any
 * discount credited alongside a deposit, and an "(INSTALLMENT n/N)" tag on
 * standalone installment heads.
 */
describe('VouchersService.buildDepositsPanel', () => {
  const termOf = () => ({}) as any;

  const build = (deposits: any[]) => {
    const findMany = jest.fn().mockResolvedValue(deposits);
    const prisma: any = { deposits: { findMany } };
    const service = new VouchersService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, findMany };
  };

  // buildDepositsPanel(studentId, termOf, standaloneSequenceMap, installmentGroups)
  const panel = (
    service: any,
    studentId: number,
    seq: Map<number, number> = new Map(),
    groups: Map<number, any[]> = new Map(),
  ) => service.buildDepositsPanel(studentId, termOf, seq, groups);

  const feeAlloc = (description: string, academic_year = '2025-2026') => ({
    type: 'FEE_HEAD',
    amount: 0,
    student_fees: { fee_types: { description }, academic_year, target_month: null },
  });

  it('queries only the student\'s 3 most recent deposits, newest first', async () => {
    const { service, findMany } = build([]);

    await panel(service, 7727);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { student_id: 7727 },
        orderBy: { deposit_date: 'desc' },
        take: 3,
      }),
    );
  });

  it('emits the deposits oldest-first with a running total and a count-aware title', async () => {
    // prisma returns them deposit_date desc; the panel must flip to chronological.
    const { service } = build([
      { total_amount: '1000', deposit_date: new Date('2026-09-01'), payment_method: 'cash', deposit_allocations: [feeAlloc('LATE FEE PLACEHOLDER')] },
      { total_amount: '16950', deposit_date: new Date('2026-07-09'), payment_method: 'online', deposit_allocations: [feeAlloc('MONTHLY TUITION FEE')] },
      { total_amount: '16975', deposit_date: new Date('2026-06-09'), payment_method: 'cash', deposit_allocations: [feeAlloc('MONTHLY TUITION FEE')] },
    ]);

    const { paymentHistory, paymentHistoryTitle } = await panel(service, 7727);

    expect(paymentHistoryTitle).toBe('PAYMENT HISTORY (LAST 3 PAYMENTS)');
    expect(paymentHistory.map((p: any) => p.date)).toEqual(['2026-06-09', '2026-07-09', '2026-09-01']);
    expect(paymentHistory.map((p: any) => p.amount)).toEqual(['16,975', '16,950', '1,000']);
    expect(paymentHistory.map((p: any) => p.totalAmount)).toEqual(['16,975', '33,925', '34,925']);
    expect(paymentHistory[paymentHistory.length - 1].totalAmount).toBe('34,925');
    expect(paymentHistory.every((p: any) => p.isDiscount === false)).toBe(true);
  });

  it('renders a discount allocation as a green sub-row that does not move the total', async () => {
    const { service } = build([
      {
        total_amount: '61650',
        deposit_date: new Date('2026-11-05'),
        payment_method: 'cash',
        deposit_allocations: [
          feeAlloc('MONTHLY TUITION FEE'),
          { type: 'DISCOUNT', amount: '1000', student_fees: { fee_types: { description: 'MONTHLY TUITION FEE' }, academic_year: '2026-2027', target_month: null } },
        ],
      },
    ]);

    const { paymentHistory } = await panel(service, 44);

    expect(paymentHistory).toHaveLength(2);
    expect(paymentHistory[0]).toMatchObject({ amount: '61,650', totalAmount: '61,650', isDiscount: false });
    expect(paymentHistory[1]).toMatchObject({
      head: 'DISCOUNT APPLIED',
      amount: '-1,000',
      totalAmount: '61,650', // unchanged — discount is not cash
      isDiscount: true,
      payment_method: null,
    });
  });

  it('collapses a multi-allocation deposit into one comma-joined HEAD', async () => {
    const { service } = build([
      {
        total_amount: '17975',
        deposit_date: new Date('2026-08-07'),
        payment_method: 'cash',
        deposit_allocations: [
          feeAlloc('MONTHLY TUITION FEE'),
          { type: 'LATE_FEE', amount: '1000', student_fees: null },
          { type: 'SURCHARGE', amount: '0', student_fees: null },
        ],
      },
    ]);

    const { paymentHistory } = await panel(service, 7727);

    expect(paymentHistory).toHaveLength(1);
    expect(paymentHistory[0].head).toBe('MONTHLY TUITION FEE, LATE FEE, ARREAR SURCHARGE');
  });

  it('tags a standalone installment head with its position in the plan', async () => {
    const { service } = build([
      {
        total_amount: '8400',
        deposit_date: new Date('2026-09-02'),
        payment_method: 'cash',
        deposit_allocations: [
          {
            type: 'FEE_HEAD',
            amount: 0,
            student_fees: {
              id: 555,
              installment_id: 9,
              fee_type_id: 42,
              split_pair_id: null,
              academic_year: '2026-2027',
              target_month: null,
              fee_types: { description: 'ANNUAL CHARGES' },
              student_fee_installments: { fee_type_id: 42, installment_count: 4 },
            },
          },
        ],
      },
    ]);

    const seq = new Map<number, number>([[555, 1]]);
    const { paymentHistory } = await panel(service, 7727, seq);

    expect(paymentHistory[0].head).toBe('ANNUAL CHARGES (INSTALLMENT 1/4)');
  });

  it('falls back to the balance sibling\'s slot for a PARTIAL PAYMENT installment fragment', async () => {
    const { service } = build([
      {
        total_amount: '4000',
        deposit_date: new Date('2026-09-02'),
        payment_method: 'cash',
        deposit_allocations: [
          {
            type: 'FEE_HEAD',
            amount: 0,
            student_fees: {
              id: 900, // the PARTIAL fragment — not in the sequence map
              installment_id: 9,
              fee_type_id: 42,
              split_pair_id: 555, // its BALANCE sibling, which holds the slot
              description_prefix: 'PARTIAL PAYMENT OF',
              academic_year: '2026-2027',
              target_month: null,
              fee_types: { description: 'ANNUAL CHARGES' },
              student_fee_installments: { fee_type_id: 42, installment_count: 4 },
            },
          },
        ],
      },
    ]);

    const seq = new Map<number, number>([[555, 2]]);
    const { paymentHistory } = await panel(service, 7727, seq);

    expect(paymentHistory[0].head).toBe('PARTIAL PAYMENT OF ANNUAL CHARGES (INSTALLMENT 2/4)');
  });

  it('titles the panel by the real count when fewer than 3 deposits exist', async () => {
    const { service } = build([
      { total_amount: '5000', deposit_date: new Date('2026-05-01'), payment_method: 'cash', deposit_allocations: [feeAlloc('ADMISSION FEE')] },
    ]);

    const { paymentHistory, paymentHistoryTitle } = await panel(service, 1);

    expect(paymentHistoryTitle).toBe('PAYMENT HISTORY (LAST 1 PAYMENT)');
    expect(paymentHistory).toHaveLength(1);
    expect(paymentHistory[0].totalAmount).toBe('5,000');
  });

  it('handles a student with no deposits', async () => {
    const { service } = build([]);

    const { paymentHistory, paymentHistoryTitle } = await panel(service, 1);

    expect(paymentHistory).toEqual([]);
    expect(paymentHistoryTitle).toBe('PAYMENT HISTORY');
  });
});
