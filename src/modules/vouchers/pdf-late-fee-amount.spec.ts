// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { Prisma } from '@prisma/client';
import { pdfLateFeeAmount } from './vouchers.service';

/** The challan's late fee is the stored after-due gap, not a flat 1,000 (#232). */
describe('pdfLateFeeAmount', () => {
  const v = (late_fee_charge: boolean, before: number, after: number | null) => ({
    late_fee_charge,
    total_payable_before_due: new Prisma.Decimal(before),
    total_payable_after_due: after == null ? null : new Prisma.Decimal(after),
  });

  it('is 0 when the voucher charges no late fee', () => {
    expect(pdfLateFeeAmount(v(false, 13289, 14289))).toBe(0);
  });

  it('prints the stored gap for a normal voucher', () => {
    expect(pdfLateFeeAmount(v(true, 40405, 41405))).toBe(1000);
  });

  it('prints no late fee for the paid half of a split when none was deposited (10260012307)', () => {
    expect(pdfLateFeeAmount(v(true, 13289, 13289))).toBe(0);
  });

  it('prints the deposited late fee for a paid split that collected it (#285)', () => {
    // Agreement: PAYABLE BY 99,000 / LATE PAYMENT SURCHARGE 1,000 / AFTER DUE 100,000.
    expect(pdfLateFeeAmount(v(true, 99000, 100000))).toBe(1000);
  });

  it('falls back to 1,000 when no after-due total was stored', () => {
    expect(pdfLateFeeAmount(v(true, 5000, null))).toBe(1000);
    expect(pdfLateFeeAmount(v(true, 5000, 0))).toBe(1000);
  });
});
