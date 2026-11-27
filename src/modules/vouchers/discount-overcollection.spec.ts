// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { discountLeftUnusedByCash } from './discount-overcollection';
import { VouchersService } from './vouchers.service';

/**
 * TAFSD-581. Voucher 14176 (CC 7165) printed Rs 233,943 after due: Rs 272,599
 * of tuition, a Rs 39,656 "full year advance payment" discount, and a Rs 1,000
 * late fee. It had expired when the family paid, and for an EXPIRED voucher
 * normalizeVoucher attached no net total, so the deposit page summed the
 * heads, skipped the discount, and asked for (and recorded) Rs 273,599.
 */
describe('discountLeftUnusedByCash', () => {
  const over = (i: {
    discountCapacity: number;
    discountConsumed: number;
    headsStillShort: number;
    cashToHeads: number;
  }) => discountLeftUnusedByCash(i).toNumber();

  it('flags cash that pays every head in full while the discount sits unused (voucher 14176)', () => {
    expect(
      over({ discountCapacity: 39656, discountConsumed: 0, headsStillShort: 0, cashToHeads: 272599 }),
    ).toBe(39656);
  });

  it('passes the discounted amount: the discount closed the last head', () => {
    expect(
      over({ discountCapacity: 39656, discountConsumed: 39656, headsStillShort: 0, cashToHeads: 232943 }),
    ).toBe(0);
  });

  it('passes a part payment: a head is still short, the discount can close it later', () => {
    expect(
      over({ discountCapacity: 4000, discountConsumed: 0, headsStillShort: 10000, cashToHeads: 10000 }),
    ).toBe(0);
  });

  it('caps the over-collection at the cash this deposit put on heads', () => {
    // A discount bigger than what was left: 1,000 of cash was all over-collected.
    expect(
      over({ discountCapacity: 10000, discountConsumed: 7000, headsStillShort: 0, cashToHeads: 1000 }),
    ).toBe(1000);
  });

  it('ignores a deposit with no cash on heads (late fee or surcharge only)', () => {
    expect(
      over({ discountCapacity: 4000, discountConsumed: 0, headsStillShort: 0, cashToHeads: 0 }),
    ).toBe(0);
  });

  it('is a no-op on a voucher without a discount', () => {
    expect(
      over({ discountCapacity: 0, discountConsumed: 0, headsStillShort: 0, cashToHeads: 20000 }),
    ).toBe(0);
  });
});

describe('VouchersService.normalizeVoucher — EXPIRED vouchers get net totals', () => {
  const normalize = (voucher: any) =>
    (new VouchersService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any)
      .normalizeVoucher(voucher, new Map());

  const fee = (id: number, amount: number, paid = 0, isDiscount = false) => ({
    id,
    amount: String(amount),
    amount_before_discount: isDiscount ? null : String(amount),
    amount_paid: String(paid),
    status: isDiscount ? 'DISCOUNT' : paid >= amount ? 'PAID' : 'ISSUED',
    is_discount: isDiscount,
    month: isDiscount ? null : 9,
    target_month: 9,
    academic_year: '2026-2027',
    fee_date: '2026-11-01T00:00:00.000Z',
    fee_types: isDiscount ? null : { description: 'Monthly Tuition Fee', priority_order: 1 },
  });
  const head = (id: number, amount: number, paid = 0, isDiscount = false) => ({
    id,
    voucher_id: 1,
    student_fee_id: id,
    net_amount: String(isDiscount ? -amount : amount),
    amount_deposited: String(paid),
    balance: String(isDiscount ? 0 : amount - paid),
    waived: false,
    student_fees: fee(id, amount, paid, isDiscount),
  });
  const voucher14176 = (status: string, heads: any[]) => ({
    id: 14176,
    status,
    class_id: 3,
    month: 9,
    academic_year: '2026-2027',
    fee_date: '2026-11-01T00:00:00.000Z',
    due_date: '2026-11-09T00:00:00.000Z', // passed: the late fee is due
    late_fee_charge: true,
    total_payable_before_due: '232943',
    total_payable_after_due: '233943',
    late_fee_deposited: '0',
    voucher_heads: heads,
    voucher_arrear_surcharges: [],
  });
  const heads = () => [head(1, 11415), ...Array.from({ length: 11 }, (_, i) => head(2 + i, 23744)), head(99, 39656, 0, true)];

  it('asks for the challan amount, discount netted, not the gross', () => {
    const result = normalize(voucher14176('EXPIRED', heads()));

    expect(result.total_balance).toBe('233943.00'); // 272,599 − 39,656 + 1,000 late fee
    expect(result.total_discount_unapplied).toBe('39656.00');
    expect(result.status).toBe('EXPIRED'); // the cron's status is kept
  });

  it('agrees with an OVERDUE voucher with the same heads', () => {
    const expired = normalize(voucher14176('EXPIRED', heads()));
    const overdue = normalize(voucher14176('OVERDUE', heads()));

    expect(expired.total_balance).toBe(overdue.total_balance);
    expect(expired.head_balance).toBe(overdue.head_balance);
    expect(overdue.status).toBe('OVERDUE');
  });

  it('still leaves PAID, VOID and WAIVED vouchers untouched', () => {
    for (const status of ['PAID', 'VOID', 'WAIVED']) {
      const result = normalize(voucher14176(status, heads()));
      expect(result.status).toBe(status);
      expect(result.total_balance).toBeUndefined();
    }
  });

  it('reports PAID once a deposit has settled an expired voucher', () => {
    const paidHeads = [head(1, 1000, 1000)];
    const v = { ...voucher14176('EXPIRED', paidHeads), late_fee_deposited: '1000' };
    expect(normalize(v).status).toBe('PAID');
  });
});
