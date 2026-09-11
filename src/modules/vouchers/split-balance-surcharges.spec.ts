// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { Prisma } from '@prisma/client';
import { splitBalanceSurcharges } from './vouchers.service';

/**
 * A split's balance voucher is a new unpaid voucher of its own: it gets one
 * surcharge per arrear month still on it, for what of that surcharge is unpaid,
 * and never inherits the original's surcharge rows or waivers.
 */
describe('splitBalanceSurcharges', () => {
  const SEP = new Date('2026-09-01');
  const AY = '2026-2027';

  const head = (fee_date: string, target_month: number, net = 10000, is_discount = false) => ({
    student_fees: { fee_date, target_month, academic_year: AY, is_discount },
    net_amount: new Prisma.Decimal(net),
  });
  const surcharge = (month: number, amount: number, amount_paid: number) => ({
    arrear_fee_date: new Date(`2026-0${month}-01`),
    arrear_month: month,
    arrear_year: AY,
    amount: new Prisma.Decimal(amount),
    amount_paid: new Prisma.Decimal(amount_paid),
  });
  const view = (rows: ReturnType<typeof splitBalanceSurcharges>) =>
    rows.map((r) => [r.arrear_month, r.amount.toNumber()]);

  it('has no surcharge when the balance holds only the current month (#10880)', () => {
    // Original: August arrears + a waived August surcharge + September. The
    // partial payment cleared August; the balance is 1,990 of September only.
    const rows = splitBalanceSurcharges(
      [head('2026-09-01', 9, 1990)],
      [surcharge(8, 1000, 0)],
      SEP,
    );
    expect(rows).toEqual([]);
  });

  it('charges a waived month again when its fees are still on the balance', () => {
    // The original's waiver is not inherited — the split form decides.
    const rows = splitBalanceSurcharges(
      [head('2026-08-01', 8), head('2026-09-01', 9)],
      [surcharge(8, 1000, 0)], // waived on the original
      SEP,
    );
    expect(view(rows)).toEqual([[8, 1000]]);
  });

  it('does not charge twice when the month\'s surcharge was already paid', () => {
    // Auto-fill paid July's surcharge, then ran short on July's fees.
    const rows = splitBalanceSurcharges(
      [head('2026-07-01', 7), head('2026-09-01', 9)],
      [surcharge(7, 1000, 1000)],
      SEP,
    );
    expect(rows).toEqual([]);
  });

  it('charges only the unpaid rest of a partly paid surcharge', () => {
    const rows = splitBalanceSurcharges(
      [head('2026-07-01', 7)],
      [surcharge(7, 1000, 400)],
      SEP,
    );
    expect(view(rows)).toEqual([[7, 600]]);
  });

  it('charges the standard 1,000 for an arrear month with no surcharge row', () => {
    const rows = splitBalanceSurcharges([head('2026-06-01', 6)], [], SEP);
    expect(view(rows)).toEqual([[6, 1000]]);
    expect(rows[0].arrear_fee_date).toEqual(new Date('2026-06-01'));
  });

  it('gives one surcharge per month, however many heads that month has', () => {
    const rows = splitBalanceSurcharges(
      [head('2026-07-01', 7), head('2026-07-01', 7), head('2026-08-01', 8)],
      [surcharge(7, 1000, 0), surcharge(8, 1000, 0)],
      SEP,
    );
    expect(view(rows)).toEqual([[7, 1000], [8, 1000]]);
  });

  it('drops surcharges for months the balance no longer carries', () => {
    // Original had July and August surcharges; only August fees remain.
    const rows = splitBalanceSurcharges(
      [head('2026-08-01', 8)],
      [surcharge(7, 1000, 0), surcharge(8, 1000, 0)],
      SEP,
    );
    expect(view(rows)).toEqual([[8, 1000]]);
  });

  it('ignores discount rows and heads with nothing owed', () => {
    const rows = splitBalanceSurcharges(
      [head('2026-07-01', 7, 5000, true), head('2026-08-01', 8, 0)],
      [],
      SEP,
    );
    expect(rows).toEqual([]);
  });

  it('has no surcharges without a balance fee date', () => {
    expect(splitBalanceSurcharges([head('2026-07-01', 7)], [], null)).toEqual([]);
  });
});
