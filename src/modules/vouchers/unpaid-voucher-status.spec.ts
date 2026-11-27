// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { unpaidVoucherStatus } from './vouchers.service';

/**
 * TAFSD-622. Every path that puts a voucher back to unpaid must land where the
 * midnight scheduler would: EXPIRED once the validity date has passed, OVERDUE
 * once the due date has, else UNPAID. CC 7542's #14186 (due 9 Nov, valid to
 * 12 Nov) came back OVERDUE from a split undo on 27 Nov.
 */
describe('unpaidVoucherStatus', () => {
  // 27 Nov 2026, 10:00 in Pakistan.
  const now = new Date('2026-11-27T05:00:00.000Z');
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

  it('is EXPIRED once the validity date has passed (voucher #14186)', () => {
    expect(unpaidVoucherStatus(d('2026-11-09'), d('2026-11-12'), now)).toBe('EXPIRED');
  });

  it('is OVERDUE when the due date has passed but the voucher is still valid', () => {
    expect(unpaidVoucherStatus(d('2026-11-20'), d('2026-11-30'), now)).toBe('OVERDUE');
  });

  it('is UNPAID before the due date', () => {
    expect(unpaidVoucherStatus(d('2026-12-05'), d('2026-12-10'), now)).toBe('UNPAID');
  });

  it('counts the due and validity day itself as still open, like the scheduler', () => {
    expect(unpaidVoucherStatus(d('2026-11-27'), d('2026-11-27'), now)).toBe('UNPAID');
    expect(unpaidVoucherStatus(d('2026-11-26'), d('2026-11-27'), now)).toBe('OVERDUE');
  });

  it('uses the Pakistan date: 00:30 PKT on 28 Nov is already the 28th', () => {
    const justAfterMidnightPkt = new Date('2026-11-27T19:30:00.000Z');
    expect(unpaidVoucherStatus(d('2026-11-27'), d('2026-11-27'), justAfterMidnightPkt)).toBe('EXPIRED');
  });

  it('falls back to the due date when there is no validity date', () => {
    expect(unpaidVoucherStatus(d('2026-11-09'), null, now)).toBe('OVERDUE');
  });
});
