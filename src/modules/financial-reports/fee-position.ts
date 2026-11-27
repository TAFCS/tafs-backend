/**
 * TAFSD-620: Consolidated Fee Position Statement — receivables, recoveries and
 * balance for the same fee heads, side by side. Pure, so the money identity
 * and the sheet layouts are tested apart from the database
 * (fee-position.spec.ts); the data is loaded by
 * FinancialReportsService.exportFeePosition.
 *
 * Per student, over the heads whose fee_date is in the period (arrear
 * surcharges excluded, as on the Fee Heads report):
 *
 *   BILLED          = non-discount heads' amount (student_fees.amount, Rule 5)
 *   DISCOUNT        = discount rows' amount (separate rows, subtracted, Rule 6)
 *   WAIVED          = a WAIVED head's amount - amount_paid (Rule 9)
 *   NET RECEIVABLE  = BILLED - DISCOUNT - WAIVED
 *   TOTAL RECOVERED = heads' amount_paid - discount consumed (netPaid: cash only)
 *     FROM CREDIT   = FEE_HEAD allocations from from_credit deposits (Rule E)
 *     CASH          = TOTAL RECOVERED - FROM CREDIT
 *   NET BALANCE     = NET RECEIVABLE - TOTAL RECOVERED
 *     ON VOUCHERS   = the part on heads already billed (any status but NOT_ISSUED)
 *     NOT YET BILLED= the part on NOT_ISSUED heads
 *
 * and for every student, and every month: NET RECEIVABLE - TOTAL RECOVERED =
 * NET BALANCE. LPS (late fee + arrear surcharge collected on the period's
 * vouchers) is money over and above the fees: shown, never in the identity.
 */
import type {
  SchoolSheet,
  SchoolSheetColumn,
  SchoolSheetGroup,
} from './school-report-sheet';
import { campusLine } from './defaulter-sheet-heading';

/** The banner under the school name. */
export const FEE_POSITION_TITLE = 'CONSOLIDATED FEE POSITION STATEMENT';

/**
 * detail: a row per student with its totals; monthly: a row per student, each
 * group spread over the fee months; summary: a row per campus, then per class.
 */
export const FEE_POSITION_LAYOUTS = ['detail', 'monthly', 'summary'] as const;
export type FeePositionLayout = (typeof FEE_POSITION_LAYOUTS)[number];

export const FEE_POSITION_LAYOUT_LINE: Record<FeePositionLayout, string> = {
  detail: 'STUDENT DETAIL',
  monthly: 'MONTH BY MONTH',
  summary: 'SUMMARY BY CLASS',
};

export const FEE_POSITION_IDENTITY_LINE =
  'NET RECEIVABLE = BILLED - DISCOUNT - WAIVED   ·   NET BALANCE = NET RECEIVABLE - TOTAL RECOVERED';

/** Student statuses whose never-billed heads will never be billed. */
export const NO_LONGER_BILLED_STATUSES = [
  'LEFT',
  'EXPELLED',
  'GRADUATED',
] as const;

export interface PositionHeadInput {
  studentId: number;
  /** fee_date month, year * 12 + (month - 1). */
  month: number;
  isDiscount: boolean;
  /** fee_status_enum. */
  status: string;
  /** amount ?? amount_before_discount ?? 0. */
  amount: number;
  amountPaid: number;
  /** FEE_HEAD allocations to this head from deposits paid out of family credit. */
  fromCredit: number;
}

export interface PositionMonth {
  receivable: number;
  recovered: number;
  balance: number;
}

export interface StudentPosition {
  billed: number;
  discount: number;
  waived: number;
  netReceivable: number;
  cash: number;
  fromCredit: number;
  recovered: number;
  onVouchers: number;
  notYetBilled: number;
  balance: number;
  months: Map<number, PositionMonth>;
}

const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function emptyPosition(): StudentPosition {
  return {
    billed: 0,
    discount: 0,
    waived: 0,
    netReceivable: 0,
    cash: 0,
    fromCredit: 0,
    recovered: 0,
    onVouchers: 0,
    notYetBilled: 0,
    balance: 0,
    months: new Map(),
  };
}

/** Adds one head (or discount row) to a position. */
export function addHead(p: StudentPosition, h: PositionHeadInput): void {
  let receivable: number;
  let recovered: number;
  let balance: number;
  if (h.isDiscount) {
    // A discount's amount_paid is what it consumed. The same amount is in the
    // head's amount_paid, so it comes off recovered here (netPaid).
    p.discount = round(p.discount + h.amount);
    receivable = -h.amount;
    recovered = -h.amountPaid;
    balance = -(h.amount - h.amountPaid);
  } else {
    const waived =
      h.status === 'WAIVED' ? Math.max(0, h.amount - h.amountPaid) : 0;
    p.billed = round(p.billed + h.amount);
    p.waived = round(p.waived + waived);
    p.fromCredit = round(p.fromCredit + h.fromCredit);
    receivable = h.amount - waived;
    recovered = h.amountPaid;
    balance = h.amount - h.amountPaid - waived;
  }
  p.recovered = round(p.recovered + recovered);
  if (h.status === 'NOT_ISSUED')
    p.notYetBilled = round(p.notYetBilled + balance);
  else p.onVouchers = round(p.onVouchers + balance);
  p.netReceivable = round(p.billed - p.discount - p.waived);
  p.cash = round(p.recovered - p.fromCredit);
  p.balance = round(p.onVouchers + p.notYetBilled);
  const m = p.months.get(h.month) ?? {
    receivable: 0,
    recovered: 0,
    balance: 0,
  };
  m.receivable = round(m.receivable + receivable);
  m.recovered = round(m.recovered + recovered);
  m.balance = round(m.balance + balance);
  p.months.set(h.month, m);
}

export function summarizePositions(
  heads: PositionHeadInput[],
): Map<number, StudentPosition> {
  const out = new Map<number, StudentPosition>();
  for (const h of heads) {
    let p = out.get(h.studentId);
    if (!p) out.set(h.studentId, (p = emptyPosition()));
    addHead(p, h);
  }
  return out;
}

/** Sums positions (a class, a campus, the school). */
export function sumPositions(ps: Iterable<StudentPosition>): StudentPosition {
  const t = emptyPosition();
  for (const p of ps) {
    t.billed = round(t.billed + p.billed);
    t.discount = round(t.discount + p.discount);
    t.waived = round(t.waived + p.waived);
    t.netReceivable = round(t.netReceivable + p.netReceivable);
    t.cash = round(t.cash + p.cash);
    t.fromCredit = round(t.fromCredit + p.fromCredit);
    t.recovered = round(t.recovered + p.recovered);
    t.onVouchers = round(t.onVouchers + p.onVouchers);
    t.notYetBilled = round(t.notYetBilled + p.notYetBilled);
    t.balance = round(t.balance + p.balance);
    for (const [idx, m] of p.months) {
      const acc = t.months.get(idx) ?? {
        receivable: 0,
        recovered: 0,
        balance: 0,
      };
      acc.receivable = round(acc.receivable + m.receivable);
      acc.recovered = round(acc.recovered + m.recovered);
      acc.balance = round(acc.balance + m.balance);
      t.months.set(idx, acc);
    }
  }
  return t;
}

/** Recovered as a share of net receivable, one decimal; null when nothing was receivable. */
export function recoveryRate(p: StudentPosition): number | null {
  return p.netReceivable > 0
    ? Math.round((p.recovered / p.netReceivable) * 1000) / 10
    : null;
}

// --- The sheets -------------------------------------------------------------

export interface FeePositionStudent {
  cc: number;
  gr: string;
  name: string;
  /** students.status */
  status: string;
  /** The class the row sits under (graduated-from class for a graduate). */
  classId: number | null;
  className: string;
  section: string;
  campusCode: string;
  campusName: string;
  family?: { id: number; name: string } | null;
}

export type FeePositionGroupBy = '' | 'class' | 'section' | 'family';

export interface FeePositionSheetInput {
  layout: FeePositionLayout;
  /** Rows of the student layouts are grouped by this, with a SUBTOTAL each. */
  groupBy: FeePositionGroupBy;
  /** Students with a position, in any order. */
  students: FeePositionStudent[];
  positions: Map<number, StudentPosition>;
  /** cc -> LPS collected on the period's vouchers. */
  lps: Map<number, number>;
  /** The fee month columns of the monthly layout, oldest first. */
  months: number[];
  /** Body cells blank for zero (sheets); CSV keeps the zeros. */
  blankZeros: boolean;
}

/** classes.description -> the short LEVEL the school writes (as the defaulters sheet). */
const LEVEL_ABBREVIATIONS: Record<string, string> = {
  'PRE NURSERY': 'PRE NUR',
  NURSERY: 'NUR',
  'K.G.': 'KG',
};
const STATUS_LABELS: Record<string, string> = {
  ENROLLED: 'Enrolled',
  LEFT: 'Left',
  EXPELLED: 'Expelled',
  GRADUATED: 'Graduated',
  SOFT_ADMISSION: 'Soft Admission',
  QUICK_ADMISSION: 'Quick Admission',
};
const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

type Row = Record<string, string | number>;

const level = (s: FeePositionStudent) =>
  [
    LEVEL_ABBREVIATIONS[s.className.trim()] ?? s.className.trim(),
    s.section.trim(),
  ]
    .filter(Boolean)
    .join(' ');

/** Class in level order, then section, then name — as on every school sheet. */
export const compareFeePositionStudents = (
  a: FeePositionStudent,
  b: FeePositionStudent,
) =>
  (a.classId ?? Number.MAX_SAFE_INTEGER) -
    (b.classId ?? Number.MAX_SAFE_INTEGER) ||
  a.section.localeCompare(b.section) ||
  a.name.localeCompare(b.name);

/** "AUG", or "AUG 26" when the months run past a year and a name repeats. */
export function monthLabel(idx: number, months: number[]): string {
  const name = MONTHS[idx % 12];
  return months.length > 12
    ? `${name} ${String(Math.floor(idx / 12)).slice(-2)}`
    : name;
}

const idColumns: SchoolSheetColumn[] = [
  { header: 'C.C.', key: 'cc', width: 7 },
  { header: 'G.R. #', key: 'gr', width: 8 },
  { header: 'LEVEL', key: 'level', width: 18 },
  { header: 'STUDENT NAME', key: 'name', width: 28 },
  { header: 'STATUS', key: 'status', width: 10 },
];

/** RECEIVABLES | RECOVERIES | BALANCE in totals, then NET BALANCE on its own at the far right. */
function totalsColumns(summary: boolean): SchoolSheetColumn[] {
  return [
    {
      group: 'RECEIVABLES',
      header: 'BILLED',
      key: 'billed',
      width: 12,
      money: true,
      total: true,
    },
    {
      group: 'RECEIVABLES',
      header: 'DISCOUNT',
      key: 'discount',
      width: 11,
      money: true,
      total: true,
    },
    {
      group: 'RECEIVABLES',
      header: 'WAIVED',
      key: 'waived',
      width: 10,
      money: true,
      total: true,
    },
    {
      group: 'RECEIVABLES',
      header: 'NET RECEIVABLE',
      key: 'net',
      width: 12,
      money: true,
      total: true,
    },
    {
      group: 'RECOVERIES',
      header: 'CASH',
      key: 'cash',
      width: 12,
      money: true,
      total: true,
    },
    {
      group: 'RECOVERIES',
      header: 'FROM FAMILY CREDIT',
      key: 'credit',
      width: 10,
      money: true,
      total: true,
    },
    {
      group: 'RECOVERIES',
      header: 'TOTAL RECOVERED',
      key: 'recovered',
      width: 12,
      money: true,
      total: true,
    },
    ...(summary
      ? [{ group: 'RECOVERIES', header: '% OF NET', key: 'rate', width: 8 }]
      : []),
    {
      group: 'RECOVERIES',
      header: 'LPS (NOT IN TOTAL)',
      key: 'lps',
      width: 10,
      money: true,
      total: true,
    },
    {
      group: 'BALANCE',
      header: 'ON VOUCHERS',
      key: 'onv',
      width: 11,
      money: true,
      total: true,
    },
    {
      group: 'BALANCE',
      header: 'NOT YET BILLED',
      key: 'nyb',
      width: 11,
      money: true,
      total: true,
    },
    ...(summary
      ? [{ group: 'BALANCE', header: 'STUDENTS OWING', key: 'owing', width: 9 }]
      : []),
    {
      header: 'NET BALANCE',
      key: 'balance',
      width: 13,
      money: true,
      total: true,
    },
  ];
}

function moneyCell(n: number, blank: boolean): number | string {
  if (Math.abs(n) < 0.005) return blank ? '' : 0;
  return n;
}

function totalsCells(p: StudentPosition, lps: number, blank: boolean): Row {
  const m = (n: number) => moneyCell(n, blank);
  return {
    billed: m(p.billed),
    discount: m(-p.discount),
    waived: m(-p.waived),
    net: m(p.netReceivable),
    cash: m(p.cash),
    credit: m(p.fromCredit),
    recovered: m(p.recovered),
    lps: m(lps),
    onv: m(p.onVouchers),
    nyb: m(p.notYetBilled),
    balance: m(p.balance),
  };
}

function monthlyColumns(months: number[]): SchoolSheetColumn[] {
  const per = (group: string, prefix: string) =>
    months.map((i) => ({
      group,
      header: monthLabel(i, months),
      key: `${prefix}${i}`,
      width: 10,
      money: true,
      total: true,
    }));
  return [
    ...per('RECEIVABLES', 'r'),
    {
      group: 'RECEIVABLES',
      header: 'TOTAL',
      key: 'rT',
      width: 11,
      money: true,
      total: true,
    },
    ...per('RECOVERIES', 'c'),
    {
      group: 'RECOVERIES',
      header: 'TOTAL',
      key: 'cT',
      width: 11,
      money: true,
      total: true,
    },
    ...per('BALANCE', 'b'),
    {
      header: 'NET BALANCE',
      key: 'balance',
      width: 13,
      money: true,
      total: true,
    },
  ];
}

function monthlyCells(
  p: StudentPosition,
  months: number[],
  blank: boolean,
): Row {
  const r: Row = {};
  for (const i of months) {
    const m = p.months.get(i);
    r[`r${i}`] = moneyCell(m?.receivable ?? 0, blank);
    r[`c${i}`] = moneyCell(m?.recovered ?? 0, blank);
    r[`b${i}`] = moneyCell(m?.balance ?? 0, blank);
  }
  r.rT = moneyCell(p.netReceivable, blank);
  r.cT = moneyCell(p.recovered, blank);
  r.balance = moneyCell(p.balance, blank);
  return r;
}

function campusesOf(students: FeePositionStudent[]) {
  const byKey = new Map<
    string,
    { code: string; name: string; students: FeePositionStudent[] }
  >();
  for (const s of students) {
    const key = s.campusCode || s.campusName || 'Unassigned';
    if (!byKey.has(key))
      byKey.set(key, {
        code: s.campusCode,
        name: s.campusName || 'Unassigned',
        students: [],
      });
    byKey.get(key)!.students.push(s);
  }
  return [...byKey.values()].sort((a, b) =>
    (a.code || a.name).localeCompare(b.code || b.name),
  );
}

function groupsOf(students: FeePositionStudent[], groupBy: FeePositionGroupBy) {
  const byKey = new Map<
    string,
    {
      label: string;
      sort: Array<string | number>;
      students: FeePositionStudent[];
    }
  >();
  for (const s of students) {
    const classId = s.classId ?? Number.MAX_SAFE_INTEGER;
    const className = s.className.trim() || 'No class';
    let key: string;
    let label: string;
    let sort: Array<string | number>;
    if (groupBy === 'class') {
      key = String(classId);
      label = `CLASS ${className}`;
      sort = [classId];
    } else if (groupBy === 'section') {
      key = `${classId}:${s.section}`;
      label = `${className} ${s.section.trim() || '(no section)'}`;
      sort = [classId, s.section];
    } else {
      key = s.family ? `f${s.family.id}` : `s${s.cc}`;
      label = s.family
        ? `${s.family.name} · #${s.family.id}`
        : 'NO FAMILY ON FILE';
      sort = [
        s.family ? s.family.name.toUpperCase() : '￿',
        s.family?.id ?? s.cc,
      ];
    }
    if (!byKey.has(key))
      byKey.set(key, { label: label.toUpperCase(), sort, students: [] });
    byKey.get(key)!.students.push(s);
  }
  const cmp = (a: Array<string | number>, b: Array<string | number>) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      return typeof a[i] === 'number' && typeof b[i] === 'number'
        ? (a[i] as number) - (b[i] as number)
        : String(a[i]).localeCompare(String(b[i]));
    }
    return 0;
  };
  return [...byKey.values()].sort((a, b) => cmp(a.sort, b.sort));
}

export interface FeePositionSheets {
  columns: SchoolSheetColumn[];
  sheets: SchoolSheet[];
}

/** The workbook's sheets for a layout: a sheet per campus, and for the summary an ALL CAMPUSES sheet first. */
export function buildFeePositionSheets(
  input: FeePositionSheetInput,
): FeePositionSheets {
  const students = [...input.students].sort(compareFeePositionStudents);
  const campuses = campusesOf(students);
  const posOf = (s: FeePositionStudent) =>
    input.positions.get(s.cc) ?? emptyPosition();
  const blank = input.blankZeros;

  if (input.layout === 'summary') {
    const columns: SchoolSheetColumn[] = [
      { header: 'CLASS', key: 'label', width: 19 },
      { header: 'STUDENTS', key: 'students', width: 9 },
      // A summary row is itself a total: its TOTAL row is written here, not summed again.
      ...totalsColumns(true).map((c) => ({ ...c, total: false })),
    ];
    const line = (
      label: string,
      ss: FeePositionStudent[],
      isTotal: boolean,
    ): Row => {
      const p = sumPositions(ss.map(posOf));
      const lps = round(ss.reduce((a, s) => a + (input.lps.get(s.cc) ?? 0), 0));
      const rate = recoveryRate(p);
      return {
        label,
        students: ss.length,
        ...totalsCells(p, lps, blank && !isTotal),
        rate: rate == null ? '' : `${rate.toFixed(1)}%`,
        owing: ss.filter((s) => posOf(s).balance > 0).length,
        ...(isTotal ? { __bold: 1, __sno: '' } : {}),
      };
    };
    const sheets: SchoolSheet[] = [];
    if (campuses.length > 1) {
      sheets.push({
        tab: 'ALL CAMPUSES',
        campus: 'ALL CAMPUSES',
        columns: columns.map((c) =>
          c.key === 'label' ? { ...c, header: 'CAMPUS' } : c,
        ),
        rows: [
          ...campuses.map((c) => line(campusLine(c.name), c.students, false)),
          line('ALL CAMPUSES', students, true),
        ],
      });
    }
    for (const c of campuses) {
      const classes = groupsOf(c.students, 'class');
      sheets.push({
        tab: c.code || c.name,
        campus: campusLine(c.name),
        rows: [
          ...classes.map((g) =>
            line(g.label.replace(/^CLASS /, ''), g.students, false),
          ),
          line('TOTAL', c.students, true),
        ],
      });
    }
    return { columns, sheets };
  }

  const columns =
    input.layout === 'monthly'
      ? [...idColumns, ...monthlyColumns(input.months)]
      : [...idColumns, ...totalsColumns(false)];
  const rowOf = (s: FeePositionStudent): Row => ({
    cc: s.cc,
    gr: /^\d+$/.test(s.gr.trim()) ? Number(s.gr.trim()) : s.gr.trim(),
    level: level(s),
    name: s.name.trim().toUpperCase(),
    status: STATUS_LABELS[s.status] ?? s.status,
    ...(input.layout === 'monthly'
      ? monthlyCells(posOf(s), input.months, blank)
      : totalsCells(posOf(s), input.lps.get(s.cc) ?? 0, blank)),
  });
  const sheets: SchoolSheet[] = campuses.map((c) => {
    if (!input.groupBy) {
      return {
        tab: c.code || c.name,
        campus: campusLine(c.name),
        rows: c.students.map(rowOf),
      };
    }
    const groups: SchoolSheetGroup[] = groupsOf(c.students, input.groupBy).map(
      (g) => ({
        label: g.label,
        rows: g.students.map(rowOf),
      }),
    );
    return {
      tab: c.code || c.name,
      campus: campusLine(c.name),
      rows: groups.flatMap((g) => g.rows),
      groups,
      rowNoun: ['STUDENT', 'STUDENTS'] as [string, string],
    };
  });
  return { columns, sheets };
}

/** The same sheets as one CSV table: a Campus (and Group) column, then the sheet's columns. */
export function feePositionCsv(
  input: Omit<FeePositionSheetInput, 'blankZeros'>,
): string {
  const { columns, sheets } = buildFeePositionSheets({
    ...input,
    blankZeros: false,
  });
  const cell = (v: string | number | undefined) => {
    const text = v == null ? '' : String(v);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const grouped = input.layout !== 'summary' && Boolean(input.groupBy);
  const header = [
    'Campus',
    ...(grouped ? ['Group'] : []),
    ...columns.map((c) => (c.group ? `${c.group} ${c.header}` : c.header)),
  ];
  const lines = [header.map(cell).join(',')];
  for (const sheet of sheets) {
    const cols = sheet.columns ?? columns;
    const runs = sheet.groups ?? [{ label: '', rows: sheet.rows }];
    for (const run of runs) {
      for (const row of run.rows) {
        lines.push(
          [
            sheet.campus,
            ...(grouped ? [run.label] : []),
            ...cols.map((c) => row[c.key]),
          ]
            .map(cell)
            .join(','),
        );
      }
    }
  }
  return `\ufeff${lines.join('\n')}`;
}
