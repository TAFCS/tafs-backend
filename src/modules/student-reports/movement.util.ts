import type {
  StrengthColumn,
  StrengthGrid,
  StrengthRow,
} from './strength.util';

/**
 * TAFSD-453: Admissions and Withdrawals (report C). Every admission and every
 * departure is an event with a date, a campus and a class; the grid counts
 * them by campus (or campus → class) across sessions or months.
 */

export const MOVEMENT_MEASURES = ['both', 'admissions', 'withdrawals'] as const;
export type MovementMeasure = (typeof MOVEMENT_MEASURES)[number];

export const MOVEMENT_ROWS = ['campus', 'class'] as const;
export type MovementRows = (typeof MOVEMENT_ROWS)[number];

export const MOVEMENT_PERIODS = ['month', 'session'] as const;
export type MovementPeriod = (typeof MOVEMENT_PERIODS)[number];

/** What counts as a withdrawal. Left by default; Expelled and Graduated on request. */
export const DEPARTURE_TYPES = ['LEFT', 'EXPELLED', 'GRADUATED'] as const;
export type DepartureType = (typeof DEPARTURE_TYPES)[number];

/** The most columns one grid has: three sessions of months, or twenty sessions. */
export const MAX_PERIODS = 36;

export interface MovementEvent {
  type: 'ADMITTED' | DepartureType;
  /** YYYY-MM-DD (Pakistan time). */
  date: string;
  cc: number;
  full_name: string | null;
  gr_number: string | null;
  campus_id: number | null;
  campus: string | null;
  /** The class admitted into or left from; null when not recorded. */
  class_id: number | null;
  class_name: string | null;
  section: string | null;
  /** The student's status today. */
  status: string;
  /** The reason given when they left, if any. */
  note: string | null;
}

export interface MovementOptions {
  measure: MovementMeasure;
  rows: MovementRows;
  period: MovementPeriod;
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
}

export interface MovementPeriodValue {
  key: string;
  label: string;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The session (1 August – 31 July) a date falls in: "2026-2027". */
export function sessionOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const start = m >= 8 ? y : y - 1;
  return `${start}-${start + 1}`;
}

export function periodOf(date: string, period: MovementPeriod): string {
  return period === 'month' ? date.slice(0, 7) : sessionOf(date);
}

/** Every period from `from` to `to`, in order, empty ones included. */
export function periodsBetween(
  from: string,
  to: string,
  period: MovementPeriod,
): MovementPeriodValue[] {
  const out: MovementPeriodValue[] = [];
  if (period === 'session') {
    const first = Number(sessionOf(from).slice(0, 4));
    const last = Number(sessionOf(to).slice(0, 4));
    for (let y = first; y <= last; y++)
      out.push({
        key: `${y}-${y + 1}`,
        label: `${y}–${String(y + 1).slice(2)}`,
      });
    return out;
  }
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push({
      key: `${y}-${String(m).padStart(2, '0')}`,
      label: `${MONTHS[m - 1]} ${y}`,
    });
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export const isAdmission = (e: MovementEvent) => e.type === 'ADMITTED';

export const campusKey = (e: Pick<MovementEvent, 'campus_id'>) =>
  `c:${e.campus_id ?? 'none'}`;
export const classKey = (e: Pick<MovementEvent, 'campus_id' | 'class_id'>) =>
  `${campusKey(e)}|k:${e.class_id ?? 'none'}`;

/** The columns: one per period, or (both) admitted / withdrawn / net per period. */
export function movementColumns(
  periods: MovementPeriodValue[],
  measure: MovementMeasure,
): StrengthColumn[] {
  if (measure !== 'both')
    return periods.map((p) => ({ key: p.key, label: p.label }));
  return periods.flatMap((p) => [
    { key: `${p.key}~in`, label: 'Admitted', group: p.label },
    { key: `${p.key}~out`, label: 'Withdrawn', group: p.label },
    { key: `${p.key}~net`, label: 'Net', group: p.label, subtotal: true },
  ]);
}

/** How much one event adds to a column: +1, or (net) -1 for a withdrawal. */
function contributions(
  e: MovementEvent,
  o: MovementOptions,
): Array<[string, number]> {
  const p = periodOf(e.date, o.period);
  if (o.measure === 'admissions') return isAdmission(e) ? [[p, 1]] : [];
  if (o.measure === 'withdrawals') return isAdmission(e) ? [] : [[p, 1]];
  return isAdmission(e)
    ? [
        [`${p}~in`, 1],
        [`${p}~net`, 1],
      ]
    : [
        [`${p}~out`, 1],
        [`${p}~net`, -1],
      ];
}

/** The events a measure counts. */
export function eventsFor(
  events: MovementEvent[],
  measure: MovementMeasure,
): MovementEvent[] {
  if (measure === 'admissions') return events.filter(isAdmission);
  if (measure === 'withdrawals') return events.filter((e) => !isAdmission(e));
  return events;
}

/**
 * The grid, in the Student Strength shape so it prints and displays the same
 * way. Rows: campuses (A–Z), each followed by its classes (in class order,
 * "Class not recorded" last) when rows = class. The total is the count, or
 * (both) admitted minus withdrawn.
 */
export function buildMovementGrid(
  events: MovementEvent[],
  o: MovementOptions,
): StrengthGrid & { total_label: string } {
  const periods = periodsBetween(o.from, o.to, o.period);
  const columns = movementColumns(periods, o.measure);
  const counted = eventsFor(events, o.measure);
  const sign = (e: MovementEvent) =>
    o.measure === 'both' && !isAdmission(e) ? -1 : 1;

  const rows = new Map<string, StrengthRow>();
  const totals = { counts: {} as Record<string, number>, total: 0 };
  const add = (
    key: string,
    make: () => StrengthRow,
    e: MovementEvent,
    cells: Array<[string, number]>,
  ) => {
    const r = rows.get(key) ?? make();
    for (const [k, n] of cells) r.counts[k] = (r.counts[k] ?? 0) + n;
    r.total += sign(e);
    rows.set(key, r);
  };
  for (const e of counted) {
    const cells = contributions(e, o);
    const campus = e.campus ?? 'No campus';
    add(
      campusKey(e),
      () => ({
        key: campusKey(e),
        level: 'campus',
        campus_id: e.campus_id,
        class_id: null,
        section_id: null,
        label: campus,
        campus,
        counts: {},
        total: 0,
      }),
      e,
      cells,
    );
    if (o.rows === 'class')
      add(
        classKey(e),
        () => ({
          key: classKey(e),
          level: 'class',
          campus_id: e.campus_id,
          class_id: e.class_id,
          section_id: null,
          label: e.class_name ?? 'Class not recorded',
          campus,
          counts: {},
          total: 0,
        }),
        e,
        cells,
      );
    for (const [k, n] of cells) totals.counts[k] = (totals.counts[k] ?? 0) + n;
    totals.total += sign(e);
  }

  // Classes in the same order as Student Strength (by id), unrecorded last.
  const order = (r: StrengthRow) => r.class_id ?? Number.MAX_SAFE_INTEGER;
  const campusRows = [...rows.values()]
    .filter((r) => r.level === 'campus')
    .sort((a, b) => a.label.localeCompare(b.label));
  const sorted: StrengthRow[] = [];
  for (const c of campusRows) {
    sorted.push(c);
    sorted.push(
      ...[...rows.values()]
        .filter((r) => r.level === 'class' && r.campus_id === c.campus_id)
        .sort((a, b) => order(a) - order(b)),
    );
  }
  return {
    columns,
    rows: sorted,
    totals,
    student_count: counted.length,
    total_label:
      o.measure === 'both'
        ? 'Net'
        : o.measure === 'admissions'
          ? 'Admitted'
          : 'Withdrawn',
  };
}

/** Whether an event is behind a cell of the grid (no row: every row; no column: the row's total). */
export function eventInCell(
  e: MovementEvent,
  cell: { row?: string; column?: string },
  o: MovementOptions,
): boolean {
  if (cell.row && cell.row !== campusKey(e) && cell.row !== classKey(e))
    return false;
  if (!eventsFor([e], o.measure).length) return false;
  if (!cell.column) return true;
  const [period, part] = cell.column.split('~');
  if (periodOf(e.date, o.period) !== period) return false;
  if (part === 'in') return isAdmission(e);
  if (part === 'out') return !isAdmission(e);
  return true;
}
