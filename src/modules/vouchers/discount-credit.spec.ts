// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { Prisma } from '@prisma/client';
import { VouchersService } from './vouchers.service';

/**
 * applyDiscountCreditInTx spends a voucher's discount on heads left short after
 * cash. Manual deposits restrict it to the heads the deposit touched — unless
 * the discount can close every short head, i.e. the deposit paid the net total.
 *
 * Regression: voucher #10691 — 12 heads x 28,290 with a 45,264 discount, paid in
 * full (295,216). Auto-fill spends the net amount head by head, so month 6 got
 * 11,316 and month 7 got nothing. Only month 6 was "touched", so month 7 never
 * received the discount and the fully-paid voucher stuck at PARTIALLY_PAID.
 */
describe('VouchersService.applyDiscountCreditInTx', () => {
  const D = (n: number) => new Prisma.Decimal(n);

  const head = (id: number, net: number, deposited: number, sfOver: Partial<any> = {}) => ({
    id,
    net_amount: D(net),
    amount_deposited: D(deposited),
    balance: D(Math.max(net - deposited, 0)),
    student_fees: { id: 1000 + id, amount: D(Math.abs(net)), amount_paid: D(deposited), is_discount: false, ...sfOver },
  });
  const discountHead = (id: number, capacity: number) => ({
    id,
    net_amount: D(-capacity),
    amount_deposited: D(0),
    balance: D(0),
    student_fees: { id: 1000 + id, amount: D(capacity), amount_paid: D(0), is_discount: true },
  });

  const makeTx = (heads: any[], consumed = 0) => {
    const allocations: any[] = [];
    const tx = {
      voucher_heads: { findMany: jest.fn().mockResolvedValue(heads), update: jest.fn() },
      student_fees: { update: jest.fn() },
      deposit_allocations: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: D(consumed) } }),
        create: jest.fn(({ data }) => allocations.push(data)),
      },
    };
    return { tx: tx as any, allocations };
  };

  const svc = () => new VouchersService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  it('closes an untouched head when the discount settles the voucher (#10691)', async () => {
    // Month 6 got 11,316 of cash (short 16,974); month 7 got none (short 28,290).
    // Discount 45,264 = 16,974 + 28,290 exactly.
    const { tx, allocations } = makeTx([
      head(6, 28290, 11316),
      head(7, 28290, 0),
      discountHead(8, 45264),
    ]);

    const applied = await svc().applyDiscountCreditInTx(tx, 10691, [6], 4685);

    expect(applied.toNumber()).toBe(45264);
    expect(allocations.map((a) => [a.student_fee_id, Number(a.amount)])).toEqual([
      [1006, 16974],
      [1007, 28290],
    ]);
    expect(tx.student_fees.update).toHaveBeenCalledWith({
      where: { id: 1007 },
      data: { amount_paid: D(28290), status: 'PAID' },
    });
  });

  it('keeps a partial payment to the touched heads only', async () => {
    // Only 5,000 of cash on head 1 (short 5,000). Head 2 untouched, short 10,000.
    // Discount 12,000 cannot close both (15,000 short) — this is not a
    // settlement, so the discount must not reach into head 2.
    const { tx, allocations } = makeTx([
      head(1, 10000, 5000),
      head(2, 10000, 0),
      discountHead(3, 12000),
    ]);

    const applied = await svc().applyDiscountCreditInTx(tx, 1, [1], 99);

    expect(applied.toNumber()).toBe(5000);
    expect(allocations.map((a) => a.student_fee_id)).toEqual([1001]);
  });

  it('counts discount already consumed by earlier deposits', async () => {
    // Capacity 45,264, 16,974 already spent — 28,290 left, exactly head 7.
    const { tx, allocations } = makeTx([head(7, 28290, 0), discountHead(8, 45264)], 16974);

    const applied = await svc().applyDiscountCreditInTx(tx, 10691, [], 5000);

    expect(applied.toNumber()).toBe(28290);
    expect(allocations.map((a) => a.student_fee_id)).toEqual([1007]);
  });

  it('does nothing without a discount on the voucher', async () => {
    const { tx, allocations } = makeTx([head(1, 10000, 5000), head(2, 10000, 0)]);
    const applied = await svc().applyDiscountCreditInTx(tx, 1, [1], 99);
    expect(applied.toNumber()).toBe(0);
    expect(allocations).toEqual([]);
  });
});
