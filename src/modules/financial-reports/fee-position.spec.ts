import * as ExcelJS from 'exceljs';
import { FinancialReportsService } from './financial-reports.service';
import {
  buildFeePositionSheets,
  feePositionCsv,
  recoveryRate,
  summarizePositions,
  sumPositions,
  type FeePositionStudent,
  type PositionHeadInput,
  type StudentPosition,
} from './fee-position';

// TAFSD-620: Consolidated Fee Position Statement — receivables, recoveries and balance side by side.

const AUG = 2026 * 12 + 7;
const SEP = 2026 * 12 + 8;
const OCT = 2026 * 12 + 9;

const head = (
  studentId: number,
  month: number,
  status: string,
  amount: number,
  amountPaid: number,
  fromCredit = 0,
): PositionHeadInput => ({
  studentId,
  month,
  isDiscount: false,
  status,
  amount,
  amountPaid,
  fromCredit,
});
const discount = (
  studentId: number,
  month: number,
  status: string,
  amount: number,
  consumed: number,
): PositionHeadInput => ({
  studentId,
  month,
  isDiscount: true,
  status,
  amount,
  amountPaid: consumed,
  fromCredit: 0,
});

/**
 * 1  CLAUDE.md's discount example: a 100,000 head with a 20,000 discount, paid with 80,000.
 * 2  Part-paid then waived: 10,000 head, 4,000 paid, the rest written off.
 * 3  Half of a 12,000 head paid from family credit; next month's 12,000 not yet billed.
 * 4  On a voucher and unpaid, with an unconsumed 1,500 discount; a never-billed head with its own discount.
 * 5  Overpaid legacy head: 9,000 billed, 9,500 recorded paid.
 */
const HEADS: PositionHeadInput[] = [
  head(1, AUG, 'PAID', 100_000, 100_000),
  discount(1, AUG, 'DISCOUNT', 20_000, 20_000),
  head(2, AUG, 'WAIVED', 10_000, 4_000),
  head(2, SEP, 'PAID', 10_000, 10_000),
  head(3, AUG, 'PAID', 12_000, 12_000, 6_000),
  head(3, SEP, 'NOT_ISSUED', 12_000, 0),
  head(4, AUG, 'ISSUED', 15_000, 0),
  discount(4, AUG, 'DISCOUNT', 1_500, 0),
  head(4, OCT, 'NOT_ISSUED', 15_000, 0),
  discount(4, OCT, 'NOT_ISSUED', 1_500, 0),
  head(5, AUG, 'PAID', 9_000, 9_500),
];

const identityHolds = (p: StudentPosition) => {
  expect(p.netReceivable).toBeCloseTo(p.billed - p.discount - p.waived, 2);
  expect(p.recovered).toBeCloseTo(p.cash + p.fromCredit, 2);
  expect(p.balance).toBeCloseTo(p.onVouchers + p.notYetBilled, 2);
  expect(p.netReceivable - p.recovered).toBeCloseTo(p.balance, 2);
  const months = [...p.months.values()];
  expect(months.reduce((a, m) => a + m.receivable, 0)).toBeCloseTo(
    p.netReceivable,
    2,
  );
  expect(months.reduce((a, m) => a + m.recovered, 0)).toBeCloseTo(
    p.recovered,
    2,
  );
  expect(months.reduce((a, m) => a + m.balance, 0)).toBeCloseTo(p.balance, 2);
  for (const m of months)
    expect(m.receivable - m.recovered).toBeCloseTo(m.balance, 2);
};

describe('Fee position money (TAFSD-620)', () => {
  const pos = summarizePositions(HEADS);

  it('receivable - recovered = balance for every student, every month, and the school', () => {
    for (const p of pos.values()) identityHolds(p);
    identityHolds(sumPositions(pos.values()));
  });

  it('subtracts a discount, and counts only cash as recovered', () => {
    expect(pos.get(1)).toMatchObject({
      billed: 100_000,
      discount: 20_000,
      netReceivable: 80_000,
      recovered: 80_000,
      cash: 80_000,
      balance: 0,
    });
  });

  it('takes the waived part as amount - amount_paid, keeping the cash', () => {
    expect(pos.get(2)).toMatchObject({
      billed: 20_000,
      waived: 6_000,
      netReceivable: 14_000,
      recovered: 14_000,
      balance: 0,
    });
    expect(pos.get(2)!.months.get(AUG)).toEqual({
      receivable: 4_000,
      recovered: 4_000,
      balance: 0,
    });
  });

  it('splits recovered into cash and family credit (Rule E), and never-billed heads into NOT YET BILLED', () => {
    expect(pos.get(3)).toMatchObject({
      recovered: 12_000,
      fromCredit: 6_000,
      cash: 6_000,
      onVouchers: 0,
      notYetBilled: 12_000,
      balance: 12_000,
    });
  });

  it('nets an unused discount out of the balance where its head sits', () => {
    expect(pos.get(4)).toMatchObject({
      billed: 30_000,
      discount: 3_000,
      netReceivable: 27_000,
      recovered: 0,
      onVouchers: 13_500,
      notYetBilled: 13_500,
      balance: 27_000,
    });
  });

  it('shows an overpayment as a minus balance', () => {
    expect(pos.get(5)).toMatchObject({
      netReceivable: 9_000,
      recovered: 9_500,
      balance: -500,
    });
  });

  it('recovery rate is recovered over net receivable', () => {
    expect(recoveryRate(pos.get(4)!)).toBe(0);
    expect(recoveryRate(sumPositions([pos.get(1)!, pos.get(2)!]))).toBe(100);
    expect(recoveryRate(sumPositions([pos.get(1)!, pos.get(3)!]))).toBe(88.5);
    expect(recoveryRate(sumPositions([]))).toBeNull();
  });
});

const student = (
  cc: number,
  over: Partial<FeePositionStudent> = {},
): FeePositionStudent => ({
  cc,
  gr: String(5000 + cc),
  name: `Student ${cc}`,
  status: 'ENROLLED',
  classId: 18,
  className: 'IX',
  section: 'A',
  campusCode: 'GEJ',
  campusName: 'Gulistan-e-Johar Campus',
  family: { id: 7, name: 'Khan' },
  ...over,
});
const STUDENTS = [
  student(1),
  student(2, { section: 'B' }),
  student(3, { classId: 19, className: 'X' }),
  student(4, { status: 'LEFT', classId: 19, className: 'X' }),
  student(5, {
    campusCode: 'KNF',
    campusName: 'Kaneez Fatima Campus',
    family: null,
  }),
];
const INPUT = {
  students: STUDENTS,
  positions: summarizePositions(HEADS),
  lps: new Map([[1, 1_000]]),
  months: [AUG, SEP, OCT],
};

describe('Fee position sheets (TAFSD-620)', () => {
  it('student detail: the three groups, NET BALANCE alone at the far right, a sheet per campus', () => {
    const { columns, sheets } = buildFeePositionSheets({
      ...INPUT,
      layout: 'detail',
      groupBy: 'class',
      blankZeros: true,
    });
    expect(columns.map((c) => c.key)).toEqual([
      'cc',
      'gr',
      'level',
      'name',
      'status',
      'billed',
      'discount',
      'waived',
      'net',
      'cash',
      'credit',
      'recovered',
      'lps',
      'onv',
      'nyb',
      'balance',
    ]);
    expect([...new Set(columns.map((c) => c.group).filter(Boolean))]).toEqual([
      'RECEIVABLES',
      'RECOVERIES',
      'BALANCE',
    ]);
    expect(columns[columns.length - 1]).toMatchObject({
      header: 'NET BALANCE',
      total: true,
    });
    expect(columns[columns.length - 1].group).toBeUndefined();
    expect(sheets.map((s) => s.tab)).toEqual(['GEJ', 'KNF']);
    expect(sheets[0].groups!.map((g) => g.label)).toEqual([
      'CLASS IX',
      'CLASS X',
    ]);
    const ali = sheets[0].rows.find((r) => r.cc === 1)!;
    // Discount shows as a minus; zero cells are blank on the sheet.
    expect(ali).toMatchObject({
      billed: 100_000,
      discount: -20_000,
      waived: '',
      net: 80_000,
      recovered: 80_000,
      lps: 1_000,
      balance: '',
      level: 'IX A',
      status: 'Enrolled',
    });
    expect(sheets[0].rows.find((r) => r.cc === 4)).toMatchObject({
      status: 'Left',
      onv: 13_500,
      nyb: 13_500,
      balance: 27_000,
    });
  });

  it('month by month: receivables, recoveries and balance per fee month, then NET BALANCE', () => {
    const { columns, sheets } = buildFeePositionSheets({
      ...INPUT,
      layout: 'monthly',
      groupBy: 'section',
      blankZeros: true,
    });
    expect(columns.slice(5).map((c) => `${c.group ?? ''}:${c.header}`)).toEqual(
      [
        'RECEIVABLES:AUG',
        'RECEIVABLES:SEP',
        'RECEIVABLES:OCT',
        'RECEIVABLES:TOTAL',
        'RECOVERIES:AUG',
        'RECOVERIES:SEP',
        'RECOVERIES:OCT',
        'RECOVERIES:TOTAL',
        'BALANCE:AUG',
        'BALANCE:SEP',
        'BALANCE:OCT',
        ':NET BALANCE',
      ],
    );
    expect(sheets[0].groups!.map((g) => g.label)).toEqual([
      'IX A',
      'IX B',
      'X A',
    ]);
    const r = sheets[0].rows.find((x) => x.cc === 3)!;
    expect(r).toMatchObject({
      [`r${AUG}`]: 12_000,
      [`c${AUG}`]: 12_000,
      [`b${SEP}`]: 12_000,
      rT: 24_000,
      cT: 12_000,
      balance: 12_000,
    });
  });

  it('a long range puts the year on the month', () => {
    const months = Array.from({ length: 13 }, (_, i) => AUG + i);
    const { columns } = buildFeePositionSheets({
      ...INPUT,
      months,
      layout: 'monthly',
      groupBy: '',
      blankZeros: true,
    });
    expect(columns[5].header).toBe('AUG 26');
  });

  it('summary: an ALL CAMPUSES sheet, then classes per campus, each ending in its own total', () => {
    const { sheets } = buildFeePositionSheets({
      ...INPUT,
      layout: 'summary',
      groupBy: '',
      blankZeros: true,
    });
    expect(sheets.map((s) => s.tab)).toEqual(['ALL CAMPUSES', 'GEJ', 'KNF']);
    expect(sheets[0].columns![0].header).toBe('CAMPUS');
    const all = sheets[0].rows[sheets[0].rows.length - 1];
    expect(all).toMatchObject({
      label: 'ALL CAMPUSES',
      students: 5,
      __bold: 1,
      __sno: '',
    });
    const school = sumPositions(INPUT.positions.values());
    expect(all.balance).toBe(school.balance);
    expect(all.net).toBe(school.netReceivable);
    expect(all.owing).toBe(2);
    const gej = sheets[1].rows;
    expect(gej.map((r) => r.label)).toEqual(['IX', 'X', 'TOTAL']);
    expect(gej[1]).toMatchObject({ students: 2, rate: '23.5%' });
  });

  it('one campus has no ALL CAMPUSES sheet', () => {
    const { sheets } = buildFeePositionSheets({
      ...INPUT,
      students: STUDENTS.filter((s) => s.campusCode === 'GEJ'),
      layout: 'summary',
      groupBy: '',
      blankZeros: true,
    });
    expect(sheets.map((s) => s.tab)).toEqual(['GEJ']);
  });

  it('CSV: one table with the zeros kept and the group named', () => {
    const csv = feePositionCsv({
      ...INPUT,
      layout: 'detail',
      groupBy: 'family',
    });
    const lines = csv.replace(/^\ufeff/, '').split('\n');
    expect(lines[0]).toContain('Campus,Group,C.C.,G.R. #');
    expect(lines[0]).toContain('RECEIVABLES BILLED');
    expect(lines[0].endsWith('NET BALANCE')).toBe(true);
    expect(lines).toHaveLength(1 + STUDENTS.length);
    const ali = lines.find((l) => l.includes(',1,5001,'))!;
    expect(ali.startsWith('GULISTAN-E-JOHAR CAMPUS,KHAN · #7,')).toBe(true);
    expect(ali.endsWith(',0')).toBe(true);
  });
});

// --- The export, end to end over a mocked database --------------------------

const fd = (iso: string) => new Date(`${iso}T00:00:00Z`);
const group = (
  student_id: number,
  fee_date: string,
  status: string,
  amount: number,
  paid: number,
  is_discount = false,
) => ({
  student_id,
  fee_date: fd(fee_date),
  is_discount,
  status,
  _sum: { amount, amount_paid: paid },
});

function service() {
  const studentFeesGroupBy = jest.fn(async (args: any) =>
    args.by.length === 1
      ? [{ is_discount: false, _sum: { amount: 45_000 } }]
      : [
          group(101, '2026-08-01', 'PAID', 15_000, 15_000),
          group(101, '2026-09-01', 'ISSUED', 15_000, 0),
          group(101, '2026-09-01', 'DISCOUNT', 1_000, 0, true),
          group(102, '2026-08-01', 'PAID', 20_000, 20_000),
        ],
  );
  const allocations = jest.fn(async (args: any) =>
    args.where.type === 'FEE_HEAD'
      ? [
          {
            amount: 5_000,
            student_fees: {
              student_id: 102,
              fee_date: fd('2026-08-01'),
              is_discount: false,
              status: 'PAID',
            },
          },
        ]
      : [{ amount: 1_000, deposits: { student_id: 101 } }],
  );
  const prisma = {
    student_fees: { groupBy: studentFeesGroupBy },
    deposit_allocations: { findMany: allocations },
    students: {
      findMany: jest.fn(async () => [
        {
          cc: 101,
          gr_number: '5529',
          full_name: 'Ali',
          status: 'ENROLLED',
          class_id: 16,
          graduated_from_class_id: null,
          campuses: {
            campus_name: 'Gulistan-e-Johar Campus',
            campus_code: 'GEJ',
          },
          classes: { description: 'VII' },
          graduated_from_class: null,
          sections: { description: 'A' },
          families: null,
        },
        {
          cc: 102,
          gr_number: '5530',
          full_name: 'Sara',
          status: 'ENROLLED',
          class_id: 15,
          graduated_from_class_id: null,
          campuses: {
            campus_name: 'Gulistan-e-Johar Campus',
            campus_code: 'GEJ',
          },
          classes: { description: 'VI' },
          graduated_from_class: null,
          sections: { description: 'B' },
          families: null,
        },
      ]),
    },
  };
  const s = new FinancialReportsService(
    prisma as any,
    {} as any,
    { whereForStudents: () => ({}) } as any,
  ) as any;
  s.loadDefaulterFilterNames = jest.fn(async () => ({
    campuses: new Map(),
    classes: new Map(),
    sections: new Map(),
    segments: new Map(),
  }));
  s.staffLabel = jest.fn(async () => 'AAWAIZ ALI (aawaiz.ali)');
  return { s, prisma };
}
const user = {
  sub: 1,
  username: 'aawaiz.ali',
  role: 'SUPER_ADMIN',
  permissions: [],
};
const query = { from_date: '2026-08-01', to_date: '2026-09-30' };

describe('Consolidated Fee Position export (TAFSD-620)', () => {
  it('leaves out never-billed heads of students who left, and says how much', async () => {
    const { s, prisma } = service();
    const file = await s.exportFeePosition({ ...query, format: 'xlsx' }, user);
    expect(file.filename).toBe(
      'consolidated-fee-position-detail-2026-08-01-to-2026-09-30.xlsx',
    );
    const where = prisma.student_fees.groupBy.mock.calls[0][0].where;
    expect(where.is_arrear_surcharge).toBe(false);
    expect(where.NOT).toEqual({
      status: 'NOT_ISSUED',
      students: { status: { in: ['LEFT', 'EXPELLED', 'GRADUATED'] } },
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    const ws = wb.worksheets[0];
    const texts: string[] = [];
    ws.eachRow((r) => texts.push(String(r.getCell(1).value ?? '')));
    expect(texts).toContain('CONSOLIDATED FEE POSITION STATEMENT');
    expect(texts).toContain(
      'NOT COUNTED: 45,000 NEVER BILLED TO STUDENTS WHO HAVE LEFT, GRADUATED OR BEEN EXPELLED',
    );
    expect(texts).toContain('STUDENT DETAIL');

    // The TOTAL row reconciles: NET RECEIVABLE - TOTAL RECOVERED = NET BALANCE.
    let hdr = 1;
    while (ws.getCell(hdr, 1).value !== 'S#') hdr++;
    const headers = (ws.getRow(hdr + 1).values as unknown[]).map((v, i) =>
      String(v ?? ws.getCell(hdr, i).value ?? ''),
    );
    const col = (name: string) => headers.indexOf(name);
    const totalRow = ws.getRow(ws.rowCount);
    expect(totalRow.getCell(col('NET RECEIVABLE')).value).toBe(49_000);
    expect(totalRow.getCell(col('TOTAL RECOVERED')).value).toBe(35_000);
    expect(totalRow.getCell(col('CASH')).value).toBe(30_000);
    expect(totalRow.getCell(col('FROM FAMILY CREDIT')).value).toBe(5_000);
    expect(totalRow.getCell(col('NET BALANCE')).value).toBe(14_000);
  });

  it('counts them when asked, and skips the left-out query', async () => {
    const { s, prisma } = service();
    await s.exportFeePosition(
      { ...query, format: 'csv', include_unbilled_after_leaving: true },
      user,
    );
    expect(prisma.student_fees.groupBy).toHaveBeenCalledTimes(1);
    expect(
      prisma.student_fees.groupBy.mock.calls[0][0].where.NOT,
    ).toBeUndefined();
  });

  it('exports CSV for each layout', async () => {
    for (const layout of ['detail', 'monthly', 'summary']) {
      const { s } = service();
      const file = await s.exportFeePosition(
        { ...query, format: 'csv', layout },
        user,
      );
      expect(file.contentType).toBe('text/csv; charset=utf-8');
      expect(file.buffer.toString('utf8')).toContain('NET BALANCE');
    }
  });
});
