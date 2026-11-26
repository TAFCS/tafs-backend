import * as ExcelJS from 'exceljs';
import { FinancialReportsService } from './financial-reports.service';
import {
  recoveryDate,
  recoveryRemarks,
  summarizeRecoveries,
  type RecoveryDepositInput,
} from './consolidated-recoveries';

// TAFSD-604: Consolidated Recoveries — deposits in the defaulters / receivables sheet, by fee head.

const OCT = 2026 * 12 + 9;
const NOV = 2026 * 12 + 10;
const fd = (iso: string) => new Date(`${iso}T00:00:00Z`);
const head = (
  amount: number,
  fee_date: string,
  fee_type_id: number | null,
) => ({
  type: 'FEE_HEAD',
  amount,
  student_fees: { fee_date: fd(fee_date), fee_type_id },
  vouchers: { fee_date: fd(fee_date) },
});
const other = (type: string, amount: number) => ({
  type,
  amount,
  student_fees: null,
  vouchers: { fee_date: fd('2026-11-01') },
});

/**
 * Ali (VII): 14 Nov cash 12,000 = Oct tuition 10,000 + Oct lab 1,000 + late fee 1,000;
 *            20 Nov 21:00 UTC (21 Nov in Pakistan) by UBL 15,000 = Nov tuition 10,000, 5,000 to family credit.
 * Sara (VI): 20 Nov from family credit 10,000 = Nov tuition, with a 2,000 discount applied.
 */
const DEPOSITS = [
  {
    id: 1,
    student_id: 101,
    deposit_date: new Date('2026-11-14T05:00:00Z'),
    total_amount: 12000,
    excess_amount: 0,
    from_credit: false,
    payment_method: 'cash',
    deposit_allocations: [
      head(10000, '2026-10-01', 1),
      head(1000, '2026-10-01', 2),
      other('LATE_FEE', 1000),
    ],
  },
  {
    id: 2,
    student_id: 101,
    deposit_date: new Date('2026-11-20T21:00:00Z'),
    total_amount: 15000,
    excess_amount: 5000,
    from_credit: false,
    payment_method: 'ubl',
    deposit_allocations: [head(10000, '2026-11-01', 1)],
  },
  {
    id: 3,
    student_id: 102,
    deposit_date: new Date('2026-11-20T06:00:00Z'),
    total_amount: 10000,
    excess_amount: 0,
    from_credit: true,
    payment_method: 'family_credit',
    deposit_allocations: [
      head(10000, '2026-11-01', 1),
      other('DISCOUNT', 2000),
    ],
  },
];

function service(deposits = DEPOSITS) {
  const prisma = {
    deposits: { findMany: jest.fn(async () => deposits) },
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
        },
      ]),
    },
    fee_types: {
      findMany: jest.fn(async () => [
        { id: 1, description: 'Tuition', priority_order: 1 },
        { id: 2, description: 'Lab', priority_order: 2 },
      ]),
    },
  };
  const s = new FinancialReportsService(
    prisma as any,
    {} as any,
    { whereForStudents: () => ({}) } as any,
  ) as any;
  s.loadSiblingGrNumbers = jest.fn(async () => new Map());
  s.loadDefaulterContacts = jest.fn(async () => new Map());
  s.loadDefaulterFamilies = jest.fn(async () => new Map());
  s.loadDefaulterFilterNames = jest.fn(async () => ({
    campuses: new Map(),
    classes: new Map(),
    sections: new Map(),
    segments: new Map(),
  }));
  s.staffLabel = jest.fn(async () => 'AAWAIZ ALI (aawaiz.ali)');
  return s;
}

const user = {
  sub: 1,
  username: 'aawaiz.ali',
  role: 'SUPER_ADMIN',
  permissions: [],
};

async function load(query: Record<string, unknown>, deposits = DEPOSITS) {
  const s = service(deposits);
  const file = await s.exportDeposits(
    {
      from_date: '2026-11-01',
      to_date: '2026-11-30',
      view: 'recoveries',
      format: 'xlsx',
      ...query,
    },
    user,
  );
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const ws = wb.worksheets[0];
  let hdr = 1;
  while (ws.getCell(hdr, 1).value !== 'S#') hdr++;
  const row = (r: number) => (ws.getRow(r).values as unknown[]).slice(1);
  const text = (r: number) => String(ws.getCell(r, 1).value ?? '');
  return { s, file, ws, hdr, row, text };
}

describe('Consolidated Recoveries export (TAFSD-604)', () => {
  it('one row per student who paid, month columns of what was recovered, and money that reconciles', async () => {
    const { file, ws, hdr, row, text } = await load({});
    expect(file.filename).toBe(
      'consolidated-recoveries-2026-11-01-to-2026-11-30.xlsx',
    );
    expect(ws.name).toBe('GEJ');
    const banners = Array.from({ length: hdr }, (_, i) => text(i + 1));
    expect(banners).toContain('CONSOLIDATED RECOVERIES');
    expect(banners).toContain(
      'RECEIVED FROM 1 NOVEMBER 2026 TO 30 NOVEMBER 2026',
    );

    const header = row(hdr);
    expect(header).toEqual(
      expect.arrayContaining([
        'OCT',
        'NOV',
        'FEE HEADS',
        'LPS',
        'TOTAL RECOVERED',
        'CASH RECEIVED',
        'FROM FAMILY CREDIT',
        'TO FAMILY CREDIT',
        'REMARKS',
      ]),
    );
    expect(header).not.toContain('UNALLOCATED');
    const at = (h: string) => header.indexOf(h);
    const pick = (r: unknown[]) =>
      [
        'OCT',
        'NOV',
        'FEE HEADS',
        'LPS',
        'TOTAL RECOVERED',
        'CASH RECEIVED',
        'FROM FAMILY CREDIT',
        'TO FAMILY CREDIT',
      ].map((h) => r[at(h)]);

    const sara = row(hdr + 1); // class VI before VII
    const ali = row(hdr + 2);
    expect(sara[at('STUDENT NAME')]).toBe('SARA');
    expect(pick(sara)).toEqual([
      undefined,
      10000,
      10000,
      0,
      10000,
      0,
      10000,
      0,
    ]);
    expect(pick(ali)).toEqual([
      11000, 10000, 21000, 1000, 22000, 27000, 0, 5000,
    ]);
    // When the money came, and how: the deposit lines in REMARKS (21 Nov is Pakistan time).
    expect(ali[at('REMARKS')]).toBe(
      '14 NOV 2026 · 12,000 · CASH\n21 NOV 2026 · 15,000 · UBL · +5,000 TO FAMILY CREDIT',
    );
    expect(sara[at('REMARKS')]).toBe(
      '20 NOV 2026 · 10,000 · FROM FAMILY CREDIT\nDISCOUNT APPLIED 2,000',
    );

    const total = row(hdr + 3);
    expect(pick(total).slice(2)).toEqual([
      31000, 1000, 32000, 27000, 10000, 5000,
    ]);
    // CASH RECEIVED + FROM FAMILY CREDIT = TOTAL RECOVERED + TO FAMILY CREDIT
    expect(27000 + 10000).toBe(32000 + 5000);
  });

  it('with breakdown_by_head: each fee head under the month it was billed for', async () => {
    const { hdr, row } = await load({ breakdown_by_head: true });
    const months = row(hdr);
    const heads = row(hdr + 1);
    const oct = months.indexOf('OCT');
    expect(heads.slice(oct, oct + 3)).toEqual(['TUITION', 'LAB', 'TOTAL']);
    const ali = row(hdr + 3);
    expect(ali.slice(oct, oct + 3)).toEqual([10000, 1000, 11000]);
  });

  it('a deposit with no allocations shows an UNALLOCATED column so the row still adds up', async () => {
    const legacy = [
      {
        id: 9,
        student_id: 101,
        deposit_date: new Date('2026-11-03T05:00:00Z'),
        total_amount: 5000,
        excess_amount: 0,
        from_credit: false,
        payment_method: 'cash',
        deposit_allocations: [],
      },
    ];
    const { hdr, row } = await load({}, [...DEPOSITS, ...legacy]);
    const header = row(hdr);
    const ali = row(hdr + 2);
    expect(ali[header.indexOf('UNALLOCATED')]).toBe(5000);
    expect(ali[header.indexOf('CASH RECEIVED')]).toBe(32000);
    expect(ali[header.indexOf('REMARKS')]).toContain(
      '3 NOV 2026 · 5,000 · CASH · NO FEE HEAD RECORDED FOR 5,000',
    );
  });

  it('reads the same deposits as the Deposits report and leaves the plain export alone', async () => {
    const { s } = await load({ payment_method: ['cash'] });
    expect(s.prisma.deposits.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ payment_method: { in: ['cash'] } }),
      }),
    );
    const csv = await service().exportDeposits(
      {
        from_date: '2026-11-01',
        to_date: '2026-11-30',
        view: 'recoveries',
        format: 'csv',
      },
      user,
    );
    const [header] = csv.buffer.toString('utf8').replace('﻿', '').split('\n');
    expect(header).toBe(
      'Campus,S#,C.C.,G.R.#,Link to GR,Level,Student Name,Status,Contact,OCT,NOV,Fee heads,LPS (late fee + arrear surcharge),Total recovered,Cash received,From family credit,To family credit,Remarks',
    );
  });

  it('nothing in the period: an empty sheet that says so', async () => {
    const file = await service([]).exportDeposits(
      {
        from_date: '2026-11-01',
        to_date: '2026-11-30',
        view: 'recoveries',
        format: 'xlsx',
      },
      user,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    expect(String(wb.worksheets[0].getCell('A1').value)).toBe(
      'No deposits match the current filters.',
    );
  });
});

describe('summarizeRecoveries', () => {
  const dep = (over: Partial<RecoveryDepositInput>): RecoveryDepositInput => ({
    id: 1,
    studentId: 1,
    depositDate: new Date('2026-11-14T05:00:00Z'),
    totalAmount: 0,
    excessAmount: 0,
    fromCredit: false,
    paymentMethod: 'cash',
    allocations: [],
    ...over,
  });

  it('every student: cash + from credit = total recovered + to credit + unallocated', () => {
    const out = summarizeRecoveries([
      dep({
        totalAmount: 12000,
        allocations: [
          { type: 'FEE_HEAD', amount: 11000, month: OCT, head: 'Tuition' },
          { type: 'SURCHARGE', amount: 1000, month: null, head: 'OTHER' },
        ],
      }),
      dep({
        id: 2,
        totalAmount: 8000,
        excessAmount: 3000,
        allocations: [
          { type: 'FEE_HEAD', amount: 5000, month: NOV, head: 'Tuition' },
        ],
      }),
      dep({
        id: 3,
        totalAmount: 4000,
        fromCredit: true,
        allocations: [
          { type: 'FEE_HEAD', amount: 4000, month: NOV, head: 'Lab' },
        ],
      }),
    ]);
    const s = out.get(1)!;
    expect(s.months.get(OCT)).toEqual(new Map([['Tuition', 11000]]));
    expect(s.months.get(NOV)).toEqual(
      new Map([
        ['Tuition', 5000],
        ['Lab', 4000],
      ]),
    );
    expect([
      s.feeHeads,
      s.lps,
      s.totalRecovered,
      s.cash,
      s.fromCredit,
      s.toCredit,
      s.unallocated,
    ]).toEqual([20000, 1000, 21000, 20000, 4000, 3000, 0]);
    expect(s.cash + s.fromCredit).toBe(
      s.totalRecovered + s.toCredit + s.unallocated,
    );
  });

  it('a discount allocation is not money: it is only noted', () => {
    const s = summarizeRecoveries([
      dep({
        totalAmount: 8000,
        allocations: [
          { type: 'FEE_HEAD', amount: 8000, month: NOV, head: 'Tuition' },
          { type: 'DISCOUNT', amount: 2000, month: NOV, head: 'OTHER' },
        ],
      }),
    ]).get(1)!;
    expect([
      s.feeHeads,
      s.totalRecovered,
      s.discountApplied,
      s.unallocated,
    ]).toEqual([8000, 8000, 2000, 0]);
    expect(recoveryRemarks(s)).toEqual([
      '14 NOV 2026 · 8,000 · CASH',
      'DISCOUNT APPLIED 2,000',
    ]);
  });

  it('dates are Pakistan days', () => {
    expect(recoveryDate(new Date('2026-11-30T19:30:00Z'))).toBe('1 DEC 2026');
    expect(recoveryDate(new Date('2026-11-30T18:00:00Z'))).toBe('30 NOV 2026');
  });
});
