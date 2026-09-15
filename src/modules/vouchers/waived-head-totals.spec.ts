// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { VouchersService } from './vouchers.service';

/**
 * A WAIVED fee head is a permanent write-off, and normalizeVoucher is where the
 * deposit UI gets its numbers. Three shapes reach it and they are not the same:
 *
 *   - wholly waived  — the voucher's own status short-circuits the recalculation
 *     entirely; heads are reported untouched so the modal and the challan can
 *     show them at full value under the WAIVED stamp.
 *   - partially waived — the written-off heads must drop out of every total. Left
 *     in, student_fees still holds the full charge at amount_paid 0, so the head
 *     reports its whole amount as due: total_balance is inflated AND allHeadsPaid
 *     can never become true, so the voucher can never settle to PAID no matter
 *     how much is collected against the heads that are real.
 *   - not waived at all — unchanged.
 */
describe('VouchersService.normalizeVoucher — waived heads', () => {
  const service = () =>
    new VouchersService(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );

  const normalize = (voucher: any) =>
    (service() as any).normalizeVoucher(voucher, new Map());

  /** `waivedVia` picks which of the two markers carries the write-off. */
  const head = (
    id: number,
    amount: number,
    paid = 0,
    waivedVia: 'head' | 'fee' | null = null,
  ) => ({
    id,
    voucher_id: 1,
    student_fee_id: id,
    net_amount: String(amount),
    amount_deposited: String(paid),
    balance: String(amount - paid),
    waived: waivedVia === 'head',
    student_fees: {
      id,
      amount: String(amount),
      amount_before_discount: String(amount),
      amount_paid: String(paid),
      status: waivedVia === 'fee' ? 'WAIVED' : 'UNPAID',
      is_discount: false,
      month: 9,
      target_month: 9,
      academic_year: '2026-2027',
      fee_date: '2026-09-01T00:00:00.000Z',
      fee_types: { description: 'Monthly Tuition Fee', priority_order: 1 },
    },
  });

  const voucher = (heads: any[], status = 'UNPAID') => ({
    id: 1,
    status,
    class_id: 3,
    month: 9,
    academic_year: '2026-2027',
    fee_date: '2026-09-01T00:00:00.000Z',
    // Far future: these tests are about heads, not the overdue surcharge.
    due_date: '2099-01-01T00:00:00.000Z',
    total_payable_before_due: '0',
    total_payable_after_due: '0',
    late_fee_deposited: '0',
    voucher_heads: heads,
    voucher_arrear_surcharges: [],
  });

  it('leaves a wholly waived voucher untouched — no recalculation at all', () => {
    const result = normalize(voucher([head(1, 5000, 0, 'head')], 'WAIVED'));

    expect(result.status).toBe('WAIVED');
    // The status early-return means no derived totals are attached: the client
    // falls back to the heads' own full amounts, exactly like the challan.
    expect(result.total_balance).toBeUndefined();
  });

  it.each(['head', 'fee'] as const)(
    'excludes a waived head (marked on the %s) from the balance of a mixed voucher',
    (waivedVia) => {
      const result = normalize(
        voucher([head(1, 5000), head(2, 3000, 0, waivedVia)]),
      );

      // 5000 payable; the 3000 write-off contributes nothing.
      expect(result.total_balance).toBe('5000.00');
      expect(result.head_balance).toBe('5000.00');
      expect(result.sf_net_total).toBe('5000.00');
      expect(result.sf_gross_total).toBe('5000.00');
      expect(
        result.voucher_heads.find((h: any) => h.id === 2).balance,
      ).toBe('0');
    },
  );

  it('lets a mixed voucher reach PAID once only the payable heads are settled', () => {
    const result = normalize(
      voucher([head(1, 5000, 5000), head(2, 3000, 0, 'head')]),
    );

    // Before waived heads were excluded this stayed PARTIALLY_PAID forever: the
    // written-off head kept 3000 in totalRemHeads, so allHeadsPaid never held.
    expect(result.status).toBe('PAID');
    expect(result.total_balance).toBe('0.00');
  });

  it('is a no-op for a voucher with no waived heads', () => {
    const result = normalize(voucher([head(1, 5000), head(2, 3000)]));

    expect(result.total_balance).toBe('8000.00');
    expect(result.status).toBe('UNPAID');
  });
});
