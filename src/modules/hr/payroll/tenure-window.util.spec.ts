import {
  computeTenureWindows,
  isDateInAnyWindow,
  totalWindowDays,
} from './tenure-window.util';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// School payroll cycle: 26th of previous month through 25th. Use Sept 2026 (Aug 26 → Sep 25).
const periodStart = d('2026-08-26');
const periodEnd = d('2026-09-25');

describe('computeTenureWindows', () => {
  it('returns one full-cycle window for an employee active the whole cycle', () => {
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2024-01-01'),
      dateOfLeaving: null,
    });
    expect(windows).toEqual([{ start: periodStart, end: periodEnd }]);
    expect(totalWindowDays(windows)).toBe(31);
  });

  it('clips a mid-cycle joiner to the days from the join date onward', () => {
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2026-09-10'),
      dateOfLeaving: null,
    });
    expect(windows).toEqual([{ start: d('2026-09-10'), end: periodEnd }]);
    expect(totalWindowDays(windows)).toBe(16); // Sep 10 → Sep 25 inclusive
  });

  it('clips a mid-cycle leaver to the days up to and including the leaving date', () => {
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2024-01-01'),
      dateOfLeaving: d('2026-09-05'),
    });
    expect(windows).toEqual([{ start: periodStart, end: d('2026-09-05') }]);
    expect(totalWindowDays(windows)).toBe(11); // Aug 26 → Sep 5 inclusive
  });

  it('returns the empty array when the employee left before the cycle began', () => {
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2024-01-01'),
      dateOfLeaving: d('2026-07-01'),
    });
    expect(windows).toEqual([]);
    expect(totalWindowDays(windows)).toBe(0);
  });

  it('returns the empty array when the employee joins after the cycle ends', () => {
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2026-10-10'),
      dateOfLeaving: null,
    });
    expect(windows).toEqual([]);
  });

  it('handles a rejoin in the same cycle via progression history (two windows with a gap)', () => {
    // Scenario: ACTIVE through Sep 1, LEFT Sep 1, ACTIVE again from Sep 15.
    // After the rejoin, employee_profiles.join_date = 2026-09-15 and
    // date_of_leaving = null; the earlier ACTIVE window lives in progression.
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2026-09-15'),
      dateOfLeaving: null,
      progression: [
        // Pre-leave ACTIVE period — closed when they left on Sep 2 (DB stores
        // valid_to as the exclusive upper bound: a leave on Sep 1 closes the
        // ACTIVE period at Sep 2).
        { employment_status: 'ACTIVE', valid_from: d('2024-01-01'), valid_to: d('2026-09-02') },
        // The LEFT period itself — must NOT contribute a window.
        { employment_status: 'LEFT', valid_from: d('2026-09-02'), valid_to: d('2026-09-15') },
        // The rejoin ACTIVE period — still open.
        { employment_status: 'ACTIVE', valid_from: d('2026-09-15'), valid_to: null },
      ],
    });
    expect(windows).toEqual([
      { start: periodStart, end: d('2026-09-01') },
      { start: d('2026-09-15'), end: periodEnd },
    ]);
    expect(totalWindowDays(windows)).toBe(7 + 11); // Aug 26→Sep 1 = 7; Sep 15→Sep 25 = 11
  });

  it('merges touching windows (zero-day gap is not a real gap)', () => {
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2024-01-01'),
      dateOfLeaving: null,
      progression: [
        { employment_status: 'ACTIVE', valid_from: d('2024-01-01'), valid_to: d('2026-09-06') },
        // A spurious re-stamp with no gap — DB can hold this when a non-status
        // field (e.g. monthlyPay) changes on the day someone leaves and
        // rejoins the same day; shouldn't surface as two windows.
        { employment_status: 'ACTIVE', valid_from: d('2026-09-06'), valid_to: null },
      ],
    });
    expect(windows).toEqual([{ start: periodStart, end: periodEnd }]);
  });

  it('excludes TERMINATED periods the same way as LEFT', () => {
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2026-09-15'),
      dateOfLeaving: null,
      progression: [
        { employment_status: 'ACTIVE', valid_from: d('2024-01-01'), valid_to: d('2026-09-02') },
        { employment_status: 'TERMINATED', valid_from: d('2026-09-02'), valid_to: d('2026-09-15') },
        { employment_status: 'ACTIVE', valid_from: d('2026-09-15'), valid_to: null },
      ],
    });
    expect(windows).toHaveLength(2);
    expect(windows[0].end).toEqual(d('2026-09-01'));
    expect(windows[1].start).toEqual(d('2026-09-15'));
  });

  it('respects joinDate as a hard lower bound of the straddling window even when progression is stale', () => {
    // Progression says ACTIVE still open since Jan 2024, but the current
    // profile shows a mid-cycle rejoin — the join date wins for the window
    // that straddles it.
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2026-09-15'),
      dateOfLeaving: null,
      progression: [
        { employment_status: 'ACTIVE', valid_from: d('2024-01-01'), valid_to: null },
      ],
    });
    expect(windows).toEqual([{ start: d('2026-09-15'), end: periodEnd }]);
  });

  it('keeps a pre-leave closed ACTIVE window intact even though joinDate is after it', () => {
    // The rejoin case: joinDate = 2026-09-15, but there's a legitimate
    // earlier ACTIVE window that closed on Sep 1. That earlier window is
    // paid; only the window that *straddles* joinDate gets clipped.
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2026-09-15'),
      dateOfLeaving: null,
      progression: [
        { employment_status: 'ACTIVE', valid_from: d('2024-01-01'), valid_to: d('2026-09-02') },
        { employment_status: 'ACTIVE', valid_from: d('2026-09-15'), valid_to: null },
      ],
    });
    expect(windows).toEqual([
      { start: periodStart, end: d('2026-09-01') },
      { start: d('2026-09-15'), end: periodEnd },
    ]);
  });

  it('respects dateOfLeaving as a hard upper bound even when progression is stale', () => {
    // Progression says ACTIVE still open, but the current profile has a
    // leaving date — the leaving date wins.
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2024-01-01'),
      dateOfLeaving: d('2026-09-10'),
      progression: [
        { employment_status: 'ACTIVE', valid_from: d('2024-01-01'), valid_to: null },
      ],
    });
    expect(windows).toEqual([{ start: periodStart, end: d('2026-09-10') }]);
  });

  it('back-fills to periodStart when joinDate is null and the earliest active progression starts mid-cycle', () => {
    // Long-tenured employee with no join_date on file. A new progression row
    // was added on Sep 5 (e.g. a status snapshot) — without the back-fill,
    // Aug 26 → Sep 4 would silently drop out of the matrix even though they
    // were employed the whole time.
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: null,
      dateOfLeaving: null,
      progression: [
        { employment_status: 'ACTIVE', valid_from: d('2026-09-05'), valid_to: null },
      ],
    });
    expect(windows).toEqual([{ start: periodStart, end: periodEnd }]);
  });

  it('does not back-fill when the earliest progression entry is LEFT (legitimate gap)', () => {
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: null,
      dateOfLeaving: null,
      progression: [
        { employment_status: 'LEFT', valid_from: d('2026-07-01'), valid_to: d('2026-09-05') },
        { employment_status: 'ACTIVE', valid_from: d('2026-09-05'), valid_to: null },
      ],
    });
    expect(windows).toEqual([{ start: d('2026-09-05'), end: periodEnd }]);
  });

  it('does not back-fill when joinDate is set (mid-cycle new hire is unchanged)', () => {
    const windows = computeTenureWindows({
      periodStart,
      periodEnd,
      joinDate: d('2026-09-10'),
      dateOfLeaving: null,
      progression: [
        { employment_status: 'ACTIVE', valid_from: d('2026-09-10'), valid_to: null },
      ],
    });
    expect(windows).toEqual([{ start: d('2026-09-10'), end: periodEnd }]);
  });

  it('returns empty when periodEnd is before periodStart', () => {
    const windows = computeTenureWindows({
      periodStart: periodEnd,
      periodEnd: periodStart,
      joinDate: null,
      dateOfLeaving: null,
    });
    expect(windows).toEqual([]);
  });
});

describe('isDateInAnyWindow', () => {
  const windows = [
    { start: d('2026-08-26'), end: d('2026-09-01') },
    { start: d('2026-09-15'), end: d('2026-09-25') },
  ];

  it('is true for a day inside either window', () => {
    expect(isDateInAnyWindow(d('2026-08-28'), windows)).toBe(true);
    expect(isDateInAnyWindow(d('2026-09-20'), windows)).toBe(true);
  });

  it('is true on the inclusive boundaries', () => {
    expect(isDateInAnyWindow(d('2026-08-26'), windows)).toBe(true);
    expect(isDateInAnyWindow(d('2026-09-01'), windows)).toBe(true);
    expect(isDateInAnyWindow(d('2026-09-15'), windows)).toBe(true);
    expect(isDateInAnyWindow(d('2026-09-25'), windows)).toBe(true);
  });

  it('is false in the gap between windows', () => {
    expect(isDateInAnyWindow(d('2026-09-02'), windows)).toBe(false);
    expect(isDateInAnyWindow(d('2026-09-14'), windows)).toBe(false);
  });

  it('is false outside every window', () => {
    expect(isDateInAnyWindow(d('2026-08-25'), windows)).toBe(false);
    expect(isDateInAnyWindow(d('2026-09-26'), windows)).toBe(false);
  });
});
