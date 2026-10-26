import * as ExcelJS from 'exceljs';
import { fee_status_enum } from '@prisma/client';
import { FinancialReportsService } from './financial-reports.service';

// TAFSD-341: Fee Heads "By class" / "By fee type" / "By period" Excel in the defaulters format.

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const g = (
  student_id: number,
  fee_date: string,
  fee_type_id: number | null,
  is_discount: boolean,
  status: fee_status_enum,
  amount: number,
  amount_paid: number,
) => ({
  student_id, fee_date: d(fee_date), fee_type_id, description_prefix: null, is_discount, status,
  // Each head billed for the month of its fee date.
  target_month: Number(fee_date.slice(5, 7)), academic_year: '2026-2027', term_start_month: null,
  _sum: { amount, amount_paid }, _count: { _all: 1 },
});

function service() {
  const prisma = {
    students: {
      findMany: jest.fn(async () => [
        { cc: 101, status: 'ENROLLED', class_id: 16, graduated_from_class_id: null, classes: { description: 'VII' }, graduated_from_class: null,
          campuses: { campus_name: 'Gulistan-e-Johar Campus' } },
        { cc: 102, status: 'ENROLLED', class_id: 15, graduated_from_class_id: null, classes: { description: 'VI' }, graduated_from_class: null,
          campuses: { campus_name: 'Gulistan-e-Johar Campus' } },
      ]),
    },
    student_fees: {
      groupBy: jest.fn(async () => [
        // Ali (VII): Aug tuition 10,000 + lab 2,000 with a 1,000 discount, 8,000 cash
        // (the discount consumed 1,000 more); Sep tuition 10,000 unpaid.
        g(101, '2026-08-01', 1, false, fee_status_enum.PARTIALLY_PAID, 10000, 9000),
        g(101, '2026-08-01', 2, false, fee_status_enum.ISSUED, 2000, 0),
        g(101, '2026-08-01', null, true, fee_status_enum.DISCOUNT, 1000, 1000), // stored positive
        g(101, '2026-09-01', 1, false, fee_status_enum.ISSUED, 10000, 0),
        // Sara (VI): Aug tuition paid in full; Sep tuition 5,000 waived.
        g(102, '2026-08-01', 1, false, fee_status_enum.PAID, 10000, 10000),
        g(102, '2026-09-01', 1, false, fee_status_enum.WAIVED, 5000, 0),
      ]),
    },
    fee_types: {
      findMany: jest.fn(async () => [
        { id: 1, description: 'Tuition', priority_order: 1 },
        { id: 2, description: 'Lab', priority_order: 2 },
      ]),
    },
    campuses: { findMany: jest.fn(async () => [{ campus_name: 'Gulistan-e-Johar Campus', campus_code: 'GEJ' }]) },
    classes: { findMany: jest.fn(async () => [{ id: 15, term_start_month: 8 }, { id: 16, term_start_month: 8 }]) },
  };
  const s = new FinancialReportsService(prisma as any, {} as any, { whereForStudents: () => ({}) } as any) as any;
  s.loadDefaulterFilterNames = jest.fn(async () => ({ campuses: new Map(), classes: new Map(), sections: new Map(), segments: new Map() }));
  s.staffLabel = jest.fn(async () => 'AAWAIZ ALI (aawaiz.ali)');
  return s;
}

const user = { sub: 1, username: 'aawaiz.ali', role: 'SUPER_ADMIN', permissions: [] };

async function load(view: string, format = 'xlsx') {
  const file = await service().exportFeeHeads({ from_date: '2026-08-01', to_date: '2026-09-30', view, format }, user);
  if (format === 'csv') return { csv: file.buffer.toString('utf8') };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer as any);
  const ws = wb.worksheets[0];
  let hdr = 1;
  while (ws.getCell(hdr, 1).value !== 'S#') hdr++;
  const header = (ws.getRow(hdr).values as unknown[]).slice(1);
  const rows: unknown[][] = [];
  for (let r = hdr + 1; r <= ws.rowCount; r++) rows.push((ws.getRow(r).values as unknown[]).slice(1));
  return { ws, tab: ws.name, header, rows };
}

describe('Fee Heads summary sheets in the defaulters format (TAFSD-341)', () => {
  it('by class: classes in level order, month columns, money that adds up', async () => {
    const { tab, header, rows } = (await load('class')) as any;
    expect(tab).toBe('GEJ');
    expect(header).toEqual(['S#', 'CLASS', 'STUDENTS', 'HEADS', 'AUG', 'SEP', 'AMOUNT', 'PAID', 'WAIVED', 'OUTSTANDING']);
    // VI before VII (level order); Aug net 11,000 for Ali after the discount.
    expect(rows[0]).toEqual([1, 'VI', 1, 2, 10000, 5000, 15000, 10000, 5000, 0]);
    expect(rows[1]).toEqual([2, 'VII', 1, 4, 11000, 10000, 21000, 8000, 0, 13000]);
    // TOTAL: label over the columns before the first summed one.
    expect(rows[2].slice(2)).toEqual([2, 6, 21000, 15000, 36000, 18000, 5000, 13000]);
  });

  it('by fee type: priority order, discount its own negative row, no students total', async () => {
    const { header, rows, ws } = (await load('fee_type')) as any;
    expect(header[1]).toBe('FEE TYPE');
    expect(rows.map((r: unknown[]) => r[1]).slice(0, 3)).toEqual(['TUITION', 'LAB', 'DISCOUNT']);
    expect(rows[2]).toEqual([3, 'DISCOUNT', 1, 1, -1000, 0, -1000, -1000, 0, 0]);
    const total = rows[3];
    // STUDENTS isn't summed (a student holds several fee types): the label covers it.
    expect(total[2]).toBe('TOTAL');
    expect(total.slice(3)).toEqual([6, 21000, 15000, 36000, 18000, 5000, 13000]);
    expect(ws.getCell(ws.rowCount, 7).numFmt).toBe('0.00');
  });

  it('by period: periods in order, discount netted into its period, no students total', async () => {
    const { header, rows } = (await load('period')) as any;
    expect(header).toEqual(['S#', 'PERIOD', 'STUDENTS', 'HEADS', 'AUG', 'SEP', 'AMOUNT', 'PAID', 'WAIVED', 'OUTSTANDING']);
    // Aug: Ali 10,000 + 2,000 - 1,000 discount, Sara 10,000; 8,000 + 10,000 cash.
    expect(rows[0]).toEqual([1, 'AUG 26', 2, 4, 21000, 0, 21000, 18000, 0, 3000]);
    // Sep: Ali 10,000 unpaid, Sara 5,000 waived.
    expect(rows[1]).toEqual([2, 'SEP 26', 2, 2, 0, 15000, 15000, 0, 5000, 10000]);
    expect(rows[2][2]).toBe('TOTAL');
    expect(rows[2].slice(3)).toEqual([6, 21000, 15000, 36000, 18000, 5000, 13000]);
  });

  it('csv: flat, with the campus', async () => {
    const { csv } = (await load('class', 'csv')) as any;
    const [head, first] = csv.replace(/^﻿/, '').split('\n');
    expect(head).toBe('Campus,CLASS,STUDENTS,HEADS,AUG,SEP,AMOUNT,PAID,WAIVED,OUTSTANDING');
    expect(first).toBe('Gulistan-e-Johar Campus,VI,1,2,10000,5000,15000,10000,5000,0');
  });
});
