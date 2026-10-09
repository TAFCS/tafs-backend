// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { Prisma } from '@prisma/client';
import { pdfLateFeeAmount, splitPaidPayableTotals } from './vouchers.service';

/** PAID half of a split: 99,000 / surcharge 1,000 / 100,000 (TAFSD-285). */
describe('splitPaidPayableTotals', () => {
  const d = (n: number) => new Prisma.Decimal(n);

  it('adds the deposited due-date late fee only to after-due (#285)', () => {
    const { beforeDue, afterDue } = splitPaidPayableTotals(d(99000), d(0), d(1000));
    expect(beforeDue.toNumber()).toBe(99000);
    expect(afterDue.toNumber()).toBe(100000);
    expect(
      pdfLateFeeAmount({
        late_fee_charge: true,
        total_payable_before_due: beforeDue,
        total_payable_after_due: afterDue,
      }),
    ).toBe(1000);
  });

  it('keeps before === after when no late fee was deposited (#232)', () => {
    const { beforeDue, afterDue } = splitPaidPayableTotals(d(13289), d(0), d(0));
    expect(beforeDue.toNumber()).toBe(13289);
    expect(afterDue.toNumber()).toBe(13289);
    expect(
      pdfLateFeeAmount({
        late_fee_charge: true,
        total_payable_before_due: beforeDue,
        total_payable_after_due: afterDue,
      }),
    ).toBe(0);
  });

  it('folds paid arrear surcharges into before-due, then late fee into after-due', () => {
    const { beforeDue, afterDue } = splitPaidPayableTotals(d(98000), d(1000), d(1000));
    expect(beforeDue.toNumber()).toBe(99000);
    expect(afterDue.toNumber()).toBe(100000);
  });
});
