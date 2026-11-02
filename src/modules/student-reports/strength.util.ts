/**
 * TAFSD-451: the Student Strength grid. Students on roll counted in rows of
 * campus → class → section (with subtotals at each level) and columns of one
 * split, or two crossed ("House × Gender"). Pure, so the screen, the drill-down
 * and the Excel all count the same way.
 */

import {
  STUDENT_BENEFITS,
  STUDENT_BENEFIT_KEYS,
  type StudentBenefitKey,
} from '../students/student-benefits';

export const STRENGTH_SPLITS = [
  'gender',
  'house',
  'status',
  'age',
  'new_returning',
  'discipline',
  'segment',
  // TAFSD-452: special categories.
  'siblings',
  'category',
] as const;
export type StrengthSplit = (typeof STRENGTH_SPLITS)[number];

export const STRENGTH_SPLIT_LABELS: Record<StrengthSplit, string> = {
  gender: 'Gender',
  house: 'House',
  status: 'Status',
  age: 'Age',
  new_returning: 'New / returning',
  discipline: 'Discipline',
  segment: 'Segment',
  siblings: 'Siblings',
  category: 'Special category',
};

/**
 * TAFSD-452: a student is linked when at least one other student of the same
 * family is Enrolled. Siblings who left or graduated are listed, but don't link.
 */
export const SIBLING_FILTERS = ['LINKED', 'SINGLE'] as const;
export type SiblingFilter = (typeof SIBLING_FILTERS)[number];

/** TAFSD-455: every benefit category, or NONE. Full names only: never "FE" or "Comp". */
export const CATEGORY_FILTERS = [...STUDENT_BENEFIT_KEYS, 'NONE'] as const;
export type CategoryFilter = StudentBenefitKey | 'NONE';

/** A benefit the student holds today: switched on and not past its end date. */
export interface ActiveBenefit {
  key: StudentBenefitKey;
  /** YYYY-MM-DD, or null when it has no end date. */
  until: string | null;
}

export const STRENGTH_ROW_LEVELS = ['campus', 'class', 'section'] as const;
export type StrengthRowLevel = (typeof STRENGTH_ROW_LEVELS)[number];

export interface StrengthStudent {
  cc: number;
  full_name: string | null;
  gr_number: string | null;
  campus_id: number | null;
  campus: string | null;
  class_id: number | null;
  class_name: string | null;
  section_id: number | null;
  section: string | null;
  house_id: number | null;
  house: string | null;
  gender: string | null;
  status: string;
  dob: Date | null;
  doa: Date | null;
  discipline: string | null;
  segment_id: number | null;
  segment: string | null;
  segment_order: number | null;
  /** TAFSD-452: other students of the same family who are Enrolled. */
  enrolled_siblings: number;
  /** TAFSD-455: in STUDENT_BENEFITS order. Ended benefits are left out, so they don't count. */
  benefits: ActiveBenefit[];
}

export const isLinked = (s: Pick<StrengthStudent, 'enrolled_siblings'>) =>
  s.enrolled_siblings > 0;

/**
 * Each filter matches any of its values; empty matches everyone.
 * `endingBy` (YYYY-MM-DD, TAFSD-455) keeps students holding a benefit that ends
 * on or before that day; with categories chosen, only those benefits count.
 */
export function matchesCategoryFilters(
  s: StrengthStudent,
  siblings: readonly SiblingFilter[] | undefined,
  category: readonly CategoryFilter[] | undefined,
  endingBy?: string,
): boolean {
  if (siblings?.length) {
    const want = isLinked(s) ? 'LINKED' : 'SINGLE';
    if (!siblings.includes(want)) return false;
  }
  if (category?.length) {
    const hit =
      s.benefits.some((b) => category.includes(b.key)) ||
      (s.benefits.length === 0 && category.includes('NONE'));
    if (!hit) return false;
  }
  if (endingBy) {
    const keys = category?.filter((c) => c !== 'NONE');
    const ending = s.benefits.some(
      (b) =>
        (!keys?.length || keys.includes(b.key)) &&
        b.until != null &&
        b.until <= endingBy,
    );
    if (!ending) return false;
  }
  return true;
}

/** "Fee Endowment", or "Fee Endowment and Complementary" for a combination. */
export function categoryValue(s: Pick<StrengthStudent, 'benefits'>): SplitValue {
  if (s.benefits.length === 0)
    return { key: 'cat:none', label: 'Neither', order: 1e6 };
  const idx = s.benefits.map((b) =>
    STUDENT_BENEFITS.findIndex((x) => x.key === b.key),
  );
  return {
    key: `cat:${s.benefits.map((b) => b.key.toLowerCase()).join('+')}`,
    label: idx.map((i) => STUDENT_BENEFITS[i].label).join(' and '),
    // Single categories first in list order, then combinations.
    order: (idx.length - 1) * 1000 + idx.reduce((a, i) => a * 10 + i, 0),
  };
}

export interface StrengthContext {
  /** YYYY-MM-DD in Pakistan time. Age is completed years on this day. */
  today: string;
  /** YYYY-MM-DD: 1 August of the current session. Admitted on or after = new. */
  sessionStart: string;
}

export interface SplitValue {
  key: string;
  label: string;
  /** Sort key within the split; numbers before strings. */
  order: number | string;
}

const STATUS_ORDER = [
  'ENROLLED',
  'SOFT_ADMISSION',
  'QUICK_ADMISSION',
  'LEFT',
  'EXPELLED',
  'GRADUATED',
];
const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** Gender is free text ("MALE", "Male", "M", "boy"): fold it to three values. */
export function genderOf(raw: string | null): SplitValue {
  const g = (raw ?? '').trim().toLowerCase();
  if (/^(m|male|boy|b)$/.test(g) || g.startsWith('male') || g.startsWith('boy'))
    return { key: 'MALE', label: 'Male', order: 0 };
  if (
    /^(f|female|girl|g)$/.test(g) ||
    g.startsWith('female') ||
    g.startsWith('girl')
  )
    return { key: 'FEMALE', label: 'Female', order: 1 };
  return { key: 'UNKNOWN', label: 'Not set', order: 9 };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Completed years between `dob` and `today` (both calendar days). */
export function ageOn(dob: Date | null, today: string): number | null {
  if (!dob) return null;
  const [ty, tm, td] = today.split('-').map(Number);
  const [by, bm, bd] = isoDay(dob).split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age >= 0 && age < 100 ? age : null;
}

/** 1 August of the session `today` falls in (sessions run August–July). */
export function sessionStartFor(today: string): string {
  const [y, m] = today.split('-').map(Number);
  return `${m >= 8 ? y : y - 1}-08-01`;
}

export function splitValue(
  s: StrengthStudent,
  split: StrengthSplit,
  ctx: StrengthContext,
): SplitValue {
  switch (split) {
    case 'gender':
      return genderOf(s.gender);
    case 'house':
      return s.house_id == null
        ? { key: 'house:none', label: 'No house', order: '￿' }
        : {
            key: `house:${s.house_id}`,
            label: s.house?.trim() || `House ${s.house_id}`,
            order: (s.house ?? '').toLowerCase(),
          };
    case 'status': {
      const i = STATUS_ORDER.indexOf(s.status);
      return {
        key: s.status,
        label: titleCase(s.status),
        order: i < 0 ? 99 : i,
      };
    }
    case 'age': {
      const age = ageOn(s.dob, ctx.today);
      return age == null
        ? { key: 'age:unknown', label: 'Age unknown', order: 999 }
        : { key: `age:${age}`, label: `Age ${age}`, order: age };
    }
    case 'new_returning':
      if (!s.doa)
        return { key: 'nr:unknown', label: 'No admission date', order: 9 };
      return isoDay(s.doa) >= ctx.sessionStart
        ? { key: 'nr:new', label: 'New', order: 0 }
        : { key: 'nr:returning', label: 'Returning', order: 1 };
    case 'discipline': {
      const d = s.discipline?.trim();
      return d
        ? {
            key: `disc:${d.toLowerCase()}`,
            label: titleCase(d),
            order: d.toLowerCase(),
          }
        : { key: 'disc:none', label: 'No discipline', order: '￿' };
    }
    case 'segment':
      return s.segment_id == null
        ? { key: 'seg:none', label: 'No segment', order: 9999 }
        : {
            key: `seg:${s.segment_id}`,
            label: s.segment?.trim() || `Segment ${s.segment_id}`,
            order: s.segment_order ?? 0,
          };
    case 'siblings':
      return isLinked(s)
        ? { key: 'sib:linked', label: 'Has siblings', order: 0 }
        : { key: 'sib:single', label: 'No siblings', order: 1 };
    case 'category':
      return categoryValue(s);
  }
}

export interface StrengthColumn {
  key: string;
  label: string;
  /** The first split's value over a run of columns, when two splits are crossed. */
  group?: string;
  /** A per-group total column ("Red: Total"). */
  subtotal?: boolean;
}

export interface StrengthRow {
  key: string;
  level: StrengthRowLevel;
  campus_id: number | null;
  class_id: number | null;
  section_id: number | null;
  label: string;
  campus: string;
  counts: Record<string, number>;
  total: number;
}

export interface StrengthGrid {
  columns: StrengthColumn[];
  rows: StrengthRow[];
  totals: { counts: Record<string, number>; total: number };
  student_count: number;
}

export interface StrengthOptions {
  rows: StrengthRowLevel;
  split?: StrengthSplit | null;
  split2?: StrengthSplit | null;
}

const cmp = (a: number | string, b: number | string) =>
  typeof a === 'number' && typeof b === 'number'
    ? a - b
    : typeof a === 'number'
      ? -1
      : typeof b === 'number'
        ? 1
        : a.localeCompare(b);

export const rowKey = (
  level: StrengthRowLevel,
  s: Pick<StrengthStudent, 'campus_id' | 'class_id' | 'section_id'>,
) => {
  const c = `c:${s.campus_id ?? 'none'}`;
  if (level === 'campus') return c;
  const k = `${c}|k:${s.class_id ?? 'none'}`;
  return level === 'class' ? k : `${k}|s:${s.section_id ?? 'none'}`;
};

/** The column keys a student counts in (leaf, plus the group's subtotal when crossed). */
export function columnKeysFor(
  s: StrengthStudent,
  opts: StrengthOptions,
  ctx: StrengthContext,
): string[] {
  if (!opts.split) return [];
  const v1 = splitValue(s, opts.split, ctx);
  if (!opts.split2) return [v1.key];
  const v2 = splitValue(s, opts.split2, ctx);
  return [`${v1.key}~${v2.key}`, `${v1.key}~*`];
}

/** A second split needs a first, and crossing a split with itself is just the split. */
export function normalizeStrengthOptions(
  opts: StrengthOptions,
): StrengthOptions {
  const split = opts.split ?? null;
  const split2 =
    split && opts.split2 && opts.split2 !== split ? opts.split2 : null;
  return { rows: opts.rows, split, split2 };
}

export function buildStrengthGrid(
  students: StrengthStudent[],
  opts: StrengthOptions,
  ctx: StrengthContext,
): StrengthGrid {
  const o = normalizeStrengthOptions(opts);
  const split2 = o.split2;

  // Columns: only values that occur, in each split's own order.
  const v1s = new Map<string, SplitValue>();
  const v2s = new Map<string, SplitValue>();
  if (o.split)
    for (const s of students) {
      const a = splitValue(s, o.split, ctx);
      v1s.set(a.key, a);
      if (split2) {
        const b = splitValue(s, split2, ctx);
        v2s.set(b.key, b);
      }
    }
  const sorted = (m: Map<string, SplitValue>) =>
    [...m.values()].sort(
      (a, b) => cmp(a.order, b.order) || a.label.localeCompare(b.label),
    );
  const columns: StrengthColumn[] = [];
  for (const a of sorted(v1s)) {
    if (!split2) {
      columns.push({ key: a.key, label: a.label });
      continue;
    }
    for (const b of sorted(v2s))
      columns.push({
        key: `${a.key}~${b.key}`,
        label: b.label,
        group: a.label,
      });
    columns.push({
      key: `${a.key}~*`,
      label: 'Total',
      group: a.label,
      subtotal: true,
    });
  }

  // Rows at every level down to the one asked for, so each level is its own subtotal.
  const levels = STRENGTH_ROW_LEVELS.slice(
    0,
    STRENGTH_ROW_LEVELS.indexOf(o.rows) + 1,
  );
  const rows = new Map<string, StrengthRow & { order: (number | string)[] }>();
  const totals = { counts: {} as Record<string, number>, total: 0 };
  for (const s of students) {
    const keys = columnKeysFor(s, o, ctx);
    for (const level of levels) {
      const key = rowKey(level, s);
      let row = rows.get(key);
      if (!row) {
        const campus = s.campus?.trim() || 'No campus';
        const label =
          level === 'campus'
            ? campus
            : level === 'class'
              ? s.class_name?.trim() || 'No class'
              : s.section?.trim() || 'No section';
        row = {
          key,
          level,
          campus_id: s.campus_id,
          class_id: level === 'campus' ? null : s.class_id,
          section_id: level === 'section' ? s.section_id : null,
          label,
          campus,
          counts: {},
          total: 0,
          // Campus by name, class in level order (classes.id runs in level order), section by name; "none" last.
          order: [
            s.campus_id == null ? '￿' : campus.toLowerCase(),
            level === 'campus' ? -1 : (s.class_id ?? Number.MAX_SAFE_INTEGER),
            level === 'section'
              ? s.section_id == null
                ? '￿'
                : (s.section ?? '').toLowerCase()
              : '',
          ],
        };
        rows.set(key, row);
      }
      row.total++;
      for (const k of keys) row.counts[k] = (row.counts[k] ?? 0) + 1;
    }
    totals.total++;
    for (const k of keys) totals.counts[k] = (totals.counts[k] ?? 0) + 1;
  }

  const ordered = [...rows.values()].sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      const d = cmp(a.order[i], b.order[i]);
      if (d) return d;
    }
    return 0;
  });
  return {
    columns,
    rows: ordered.map((r) => {
      const out: StrengthRow & { order?: unknown } = { ...r };
      delete out.order;
      return out;
    }),
    totals,
    student_count: students.length,
  };
}

/** Whether a student falls in a grid cell: a row (any level) and optionally a column. */
export function inCell(
  s: StrengthStudent,
  cell: { row?: string | null; column?: string | null },
  opts: StrengthOptions,
  ctx: StrengthContext,
): boolean {
  if (cell.row) {
    const level: StrengthRowLevel = cell.row.includes('|s:')
      ? 'section'
      : cell.row.includes('|k:')
        ? 'class'
        : 'campus';
    if (rowKey(level, s) !== cell.row) return false;
  }
  if (cell.column)
    return columnKeysFor(s, normalizeStrengthOptions(opts), ctx).includes(
      cell.column,
    );
  return true;
}
