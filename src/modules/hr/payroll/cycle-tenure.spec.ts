import { describeCycleTenure, offRollReason } from './tenure-window.util';
import { tenureLabel } from './payroll-excel.util';

// Attendance-by-cycle shows mid-cycle joiners and leavers the way payroll
// counts them: days outside their tenure are "not on roll", not absences.

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const periodStart = d('2026-08-26');
const periodEnd = d('2026-09-25'); // 31 days

describe('describeCycleTenure', () => {
  it('full-cycle employee: no joined/left, all days on roll', () => {
    const t = describeCycleTenure({ periodStart, periodEnd, joinDate: d('2024-01-01'), dateOfLeaving: null });
    expect(t).toMatchObject({ joined_on: null, left_on: null, rejoined: false, in_tenure_days: 31, period_days: 31 });
    expect(tenureLabel(t)).toBe('');
  });

  it('mid-cycle joiner', () => {
    const t = describeCycleTenure({ periodStart, periodEnd, joinDate: d('2026-09-10'), dateOfLeaving: null });
    expect(t).toMatchObject({ joined_on: '2026-09-10', left_on: null, in_tenure_days: 16 });
    expect(offRollReason('2026-09-09', t)).toBe('BEFORE_JOIN');
    expect(offRollReason('2026-09-10', t)).toBeNull();
    expect(tenureLabel(t)).toBe('Joined 10 Sept 2026 (16 of 31 days)'.replace('Sept', new Date(Date.UTC(2026, 8, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })));
  });

  it('mid-cycle leaver', () => {
    const t = describeCycleTenure({ periodStart, periodEnd, joinDate: d('2023-05-01'), dateOfLeaving: d('2026-09-05') });
    expect(t).toMatchObject({ joined_on: null, left_on: '2026-09-05', in_tenure_days: 11 });
    expect(offRollReason('2026-09-05', t)).toBeNull();
    expect(offRollReason('2026-09-06', t)).toBe('AFTER_LEAVE');
  });

  it('left and rejoined within the cycle', () => {
    const t = describeCycleTenure({
      periodStart,
      periodEnd,
      joinDate: d('2026-09-15'),
      dateOfLeaving: null,
      progression: [
        { employment_status: 'ACTIVE', valid_from: d('2024-01-01'), valid_to: d('2026-09-01') },
        { employment_status: 'LEFT', valid_from: d('2026-09-01'), valid_to: d('2026-09-15') },
        { employment_status: 'ACTIVE', valid_from: d('2026-09-15'), valid_to: null },
      ],
    });
    expect(t.rejoined).toBe(true);
    expect(t.windows).toEqual([
      { start: '2026-08-26', end: '2026-08-31' },
      { start: '2026-09-15', end: '2026-09-25' },
    ]);
    expect(offRollReason('2026-09-05', t)).toBe('BETWEEN_TENURES');
    expect(tenureLabel(t)).toMatch(/^Rejoined 15 Sept? 2026 \(17 of 31 days\)$/);
  });

  it('joins after the cycle: no days on roll, joined_on still reported', () => {
    const t = describeCycleTenure({ periodStart, periodEnd, joinDate: d('2026-10-03'), dateOfLeaving: null });
    expect(t).toMatchObject({ windows: [], in_tenure_days: 0, joined_on: '2026-10-03' });
    expect(offRollReason('2026-09-01', t)).toBe('BEFORE_JOIN');
  });
});
