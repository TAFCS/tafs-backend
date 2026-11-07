import {
  describeCycleTenure,
  progressionOverlapWhere,
  type ProgressionPeriod,
} from './tenure-window.util';

// TAFSD-476: Asma joined on 25 Oct, the cycle's last day. Her ONBOARDED row
// opened and closed that day; the row that carried on opened later the same day.
const START = new Date('2026-09-26T00:00:00Z');
const END = new Date('2026-10-25T00:00:00Z');
const ROWS: ProgressionPeriod[] = [
  {
    employment_status: 'ACTIVE',
    valid_from: new Date('2026-10-25T00:00:00Z'),
    valid_to: new Date('2026-10-25T09:12:00Z'),
  },
  {
    employment_status: 'ACTIVE',
    valid_from: new Date('2026-10-25T09:12:00Z'),
    valid_to: new Date('2026-11-03T07:00:00Z'),
  },
  {
    employment_status: 'ACTIVE',
    valid_from: new Date('2026-11-03T07:00:00Z'),
    valid_to: null,
  },
];

/** The rows the overlap query returns. */
function fetched(rows: ProgressionPeriod[]) {
  const w = progressionOverlapWhere(START, END);
  return rows.filter(
    (r) =>
      r.valid_from < w.valid_from.lt &&
      (r.valid_to === null || r.valid_to > START),
  );
}

describe('TAFSD-476: joining on the last day of a cycle', () => {
  it('fetches a row opened later on the last day', () => {
    expect(fetched(ROWS)).toHaveLength(2);
  });

  it('pays the join day and says joined, not left', () => {
    const t = describeCycleTenure({
      periodStart: START,
      periodEnd: END,
      joinDate: new Date('2026-10-25T00:00:00Z'),
      dateOfLeaving: null,
      progression: fetched(ROWS),
    });
    expect(t.windows).toEqual([{ start: '2026-10-25', end: '2026-10-25' }]);
    expect(t.in_tenure_days).toBe(1);
    expect(t.joined_on).toBe('2026-10-25');
    expect(t.left_on).toBeNull();
  });

  it('a mid-cycle joiner reads as joined', () => {
    const t = describeCycleTenure({
      periodStart: START,
      periodEnd: END,
      joinDate: new Date('2026-10-05T00:00:00Z'),
      dateOfLeaving: null,
      progression: [
        {
          employment_status: 'ACTIVE',
          valid_from: new Date('2026-10-05T04:00:00Z'),
          valid_to: null,
        },
      ],
    });
    expect([t.joined_on, t.left_on, t.in_tenure_days]).toEqual([
      '2026-10-05',
      null,
      21,
    ]);
  });
});
