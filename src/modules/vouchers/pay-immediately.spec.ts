// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { isPayImmediate, payImmediateDueDate } from './vouchers.service';

/**
 * PAY IMMEDIATELY rule under test (spec: src/modules/vouchers/CLAUDE.md).
 *
 * Input is computeArrears() for the voucher being issued, so only heads with a
 * fee_date strictly before the new voucher's own fee_date are present — the
 * current fee_date is ignored by construction. Fires when those arrears span at
 * least two distinct fee_dates AND at least two distinct target months: the
 * student has not paid the last two vouchers issued to them.
 */
describe('isPayImmediate', () => {
  // One arrear head, shaped like a computeArrears() row.
  const head = (fee_date: string) => ({ fee_date, isSurcharge: false });
  // computeArrears() emits one virtual surcharge row per distinct month.
  const surcharge = (fee_date: string) => ({ fee_date, isSurcharge: true });
  // surcharge_groups: one entry per distinct (academic_year, target_month).
  const months = (n: number) => Array.from({ length: n }, (_, i) => ({ target_month: i + 1 }));

  it('fires for two unpaid vouchers: two fee_dates, two target months', () => {
    expect(
      isPayImmediate({
        rows: [head('2026-08-01'), head('2026-09-01'), surcharge('2026-08-01'), surcharge('2026-09-01')],
        surcharge_groups: months(2),
      }),
    ).toBe(true);
  });

  it('fires for more than two unpaid vouchers', () => {
    expect(
      isPayImmediate({
        rows: [head('2026-08-01'), head('2026-09-01'), head('2026-10-01'), head('2026-11-01')],
        surcharge_groups: months(4),
      }),
    ).toBe(true);
  });

  it('does not fire for ONE unpaid voucher spanning many months (annual billing)', () => {
    // A whole year billed on a single fee_date: twelve target months, but only
    // one voucher left unpaid. Counting target months alone wrongly fired here.
    expect(
      isPayImmediate({
        rows: Array.from({ length: 12 }, () => head('2026-08-01')),
        surcharge_groups: months(12),
      }),
    ).toBe(false);
  });

  it('does not fire for two fee_dates that share one target month', () => {
    expect(
      isPayImmediate({
        rows: [head('2026-08-01'), head('2026-08-15')],
        surcharge_groups: months(1),
      }),
    ).toBe(false);
  });

  it('does not fire for a single unpaid voucher', () => {
    expect(isPayImmediate({ rows: [head('2026-09-01')], surcharge_groups: months(1) })).toBe(false);
  });

  it('does not fire with no arrears', () => {
    expect(isPayImmediate({ rows: [], surcharge_groups: [] })).toBe(false);
  });

  it('counts only real heads — surcharge rows never add a fee_date', () => {
    expect(
      isPayImmediate({
        rows: [head('2026-08-01'), surcharge('2026-09-01')],
        surcharge_groups: months(2),
      }),
    ).toBe(false);
  });

  it('ignores heads with no fee_date', () => {
    expect(
      isPayImmediate({
        rows: [head('2026-08-01'), head('undated')],
        surcharge_groups: months(2),
      }),
    ).toBe(false);
  });
});

describe('payImmediateDueDate', () => {
  const due = (issue: string) => payImmediateDueDate(new Date(issue)).toISOString().slice(0, 10);

  it('is issue_date + 4 days when no Sunday falls in between', () => {
    expect(due('2026-09-08')).toBe('2026-09-12'); // Tue -> Sat
  });

  it('does not count Sundays: issued Friday, due the next Wednesday (+5)', () => {
    expect(due('2026-09-11')).toBe('2026-09-16'); // Fri -> Sat, (Sun), Mon, Tue, Wed
  });

  it('matches the rule for every issue weekday', () => {
    // 2026-09-06 is a Sunday.
    expect(due('2026-09-06')).toBe('2026-09-10'); // Sun -> Thu  (+4)
    expect(due('2026-09-07')).toBe('2026-09-11'); // Mon -> Fri  (+4)
    expect(due('2026-09-08')).toBe('2026-09-12'); // Tue -> Sat  (+4)
    expect(due('2026-09-09')).toBe('2026-09-14'); // Wed -> Mon  (+5)
    expect(due('2026-09-10')).toBe('2026-09-15'); // Thu -> Tue  (+5)
    expect(due('2026-09-11')).toBe('2026-09-16'); // Fri -> Wed  (+5)
    expect(due('2026-09-12')).toBe('2026-09-17'); // Sat -> Thu  (+5)
  });

  it('never lands on a Sunday', () => {
    for (let day = 1; day <= 60; day++) {
      const issue = new Date(Date.UTC(2026, 8, day));
      expect(payImmediateDueDate(issue).getUTCDay()).not.toBe(0);
    }
  });

  it('rolls over month and year ends', () => {
    expect(due('2026-09-28')).toBe('2026-10-02'); // Mon -> Fri
    expect(due('2026-12-30')).toBe('2027-01-04'); // Wed -> Mon, skipping Sun 3 Jan
  });

  it('does not mutate the issue date passed in', () => {
    const issue = new Date('2026-09-08');
    payImmediateDueDate(issue);
    expect(issue.toISOString().slice(0, 10)).toBe('2026-09-08');
  });
});
