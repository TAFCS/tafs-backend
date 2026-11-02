import {
  buildMovementGrid,
  eventInCell,
  periodsBetween,
  sessionOf,
  type MovementEvent,
  type MovementOptions,
} from './movement.util';

const ev = (over: Partial<MovementEvent>): MovementEvent => ({
  type: 'ADMITTED',
  date: '2026-08-10',
  cc: 1,
  full_name: 'A',
  gr_number: '1',
  campus_id: 1,
  campus: 'Gulistan',
  class_id: 3,
  class_name: 'Class 3',
  section: 'A',
  status: 'ENROLLED',
  note: null,
  ...over,
});

const EVENTS = [
  ev({ cc: 1 }),
  ev({ cc: 2, date: '2026-09-01' }),
  ev({ cc: 3, type: 'LEFT', date: '2026-09-15' }),
  ev({ cc: 4, class_id: null, class_name: null }),
  ev({
    cc: 5,
    campus_id: 2,
    campus: 'North',
    class_id: 5,
    class_name: 'Class 5',
    type: 'LEFT',
    date: '2026-08-20',
  }),
];
const opts = (over: Partial<MovementOptions> = {}): MovementOptions => ({
  measure: 'both',
  rows: 'class',
  period: 'month',
  from: '2026-08-01',
  to: '2026-10-31',
  ...over,
});

describe('TAFSD-453: movement periods', () => {
  it('splits sessions on 1 August', () => {
    expect(sessionOf('2026-07-31')).toBe('2025-2026');
    expect(sessionOf('2026-08-01')).toBe('2026-2027');
  });

  it('lists every month and session in the range, empty ones included', () => {
    expect(
      periodsBetween('2026-11-15', '2027-02-01', 'month').map((p) => p.label),
    ).toEqual(['Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027']);
    expect(
      periodsBetween('2024-09-01', '2026-08-02', 'session').map((p) => p.key),
    ).toEqual(['2024-2025', '2025-2026', '2026-2027']);
  });
});

describe('TAFSD-453: movement grid', () => {
  it('counts admissions, withdrawals and the net per month, by campus then class', () => {
    const g = buildMovementGrid(EVENTS, opts());
    expect(g.columns.slice(0, 3).map((c) => [c.group, c.label])).toEqual([
      ['Aug 2026', 'Admitted'],
      ['Aug 2026', 'Withdrawn'],
      ['Aug 2026', 'Net'],
    ]);
    expect(g.columns).toHaveLength(9);
    expect(g.rows.map((r) => [r.level, r.label, r.total])).toEqual([
      ['campus', 'Gulistan', 2],
      ['class', 'Class 3', 1],
      ['class', 'Class not recorded', 1],
      ['campus', 'North', -1],
      ['class', 'Class 5', -1],
    ]);
    const gul = g.rows[0].counts;
    expect([
      gul['2026-08~in'],
      gul['2026-09~in'],
      gul['2026-09~out'],
      gul['2026-09~net'],
    ]).toEqual([2, 1, 1, 0]);
    expect(g.totals.total).toBe(1);
    expect(g.total_label).toBe('Net');
  });

  it('counts only admissions or only withdrawals when asked, by session', () => {
    const a = buildMovementGrid(
      EVENTS,
      opts({ measure: 'admissions', rows: 'campus', period: 'session' }),
    );
    expect(a.columns.map((c) => c.key)).toEqual(['2026-2027']);
    expect(a.rows.map((r) => [r.label, r.total])).toEqual([['Gulistan', 3]]);
    const w = buildMovementGrid(
      EVENTS,
      opts({ measure: 'withdrawals', rows: 'campus' }),
    );
    expect(w.rows.map((r) => [r.label, r.total])).toEqual([
      ['Gulistan', 1],
      ['North', 1],
    ]);
    expect(w.student_count).toBe(2);
  });

  it('finds the students behind a cell', () => {
    const o = opts();
    const hit = (cell: { row?: string; column?: string }) =>
      EVENTS.filter((e) => eventInCell(e, cell, o)).map((e) => e.cc);
    expect(hit({ row: 'c:1|k:3', column: '2026-09~in' })).toEqual([2]);
    expect(hit({ row: 'c:1', column: '2026-09~net' })).toEqual([2, 3]);
    expect(hit({ row: 'c:1|k:none' })).toEqual([4]);
    expect(hit({ column: '2026-08~out' })).toEqual([5]);
  });
});
