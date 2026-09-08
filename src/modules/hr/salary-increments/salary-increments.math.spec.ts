import {
  addMonthsSafe,
  computeNewPay,
  dateOnly,
  daysBetween,
  monthsRemaining,
} from './salary-increments.service';

const d = (iso: string) => dateOnly(iso);

describe('salary increment date math', () => {
  describe('addMonthsSafe', () => {
    it('adds whole calendar months', () => {
      expect(addMonthsSafe(d('2026-01-15'), 12).toISOString().slice(0, 10)).toBe('2027-01-15');
      expect(addMonthsSafe(d('2026-01-15'), 14).toISOString().slice(0, 10)).toBe('2027-03-15');
      expect(addMonthsSafe(d('2026-03-10'), 6).toISOString().slice(0, 10)).toBe('2026-09-10');
    });

    it('clamps month-end anchors to the last valid day', () => {
      expect(addMonthsSafe(d('2026-01-31'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
      expect(addMonthsSafe(d('2024-01-31'), 1).toISOString().slice(0, 10)).toBe('2024-02-29');
    });
  });

  describe('monthsRemaining', () => {
    it('counts full months to a future due date', () => {
      expect(monthsRemaining(d('2026-09-09'), d('2026-12-09'))).toBe(3);
    });

    it('does not over-count when the day-of-month is not yet reached', () => {
      // ~2 months and 6 days away -> 2 whole months remaining
      expect(monthsRemaining(d('2026-09-09'), d('2026-11-15'))).toBe(2);
      // same month, earlier day -> the month is complete
      expect(monthsRemaining(d('2026-09-20'), d('2026-11-05'))).toBe(1);
    });

    it('is monotonic: a later due date never yields fewer months (regression)', () => {
      const from = d('2026-09-10');
      const early = monthsRemaining(from, d('2026-12-05'));
      const late = monthsRemaining(from, d('2026-12-25'));
      expect(late).toBeGreaterThanOrEqual(early);
    });

    it('goes negative when the due date is in the past (overdue)', () => {
      expect(monthsRemaining(d('2026-09-09'), d('2026-06-09'))).toBe(-3);
    });
  });

  describe('daysBetween', () => {
    it('measures calendar days', () => {
      expect(daysBetween(d('2026-09-09'), d('2026-09-19'))).toBe(10);
      expect(daysBetween(d('2026-09-19'), d('2026-09-09'))).toBe(-10);
    });
  });
});

describe('computeNewPay', () => {
  it('applies a percentage raise, rounded to 2 dp', () => {
    expect(computeNewPay(50000, 'PERCENTAGE', 10)).toBe(55000);
    expect(computeNewPay(33333.33, 'PERCENTAGE', 7.5)).toBe(35833.33);
  });

  it('applies a fixed raise', () => {
    expect(computeNewPay(50000, 'FIXED_AMOUNT', 5000)).toBe(55000);
    expect(computeNewPay(0, 'FIXED_AMOUNT', 1200)).toBe(1200);
  });
});
