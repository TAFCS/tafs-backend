import * as ExcelJS from 'exceljs';
import { FinancialReportsService } from './financial-reports.service';

// TAFSD-335: with breakdown_by_head, each month is a header group with one
// numeric sub-column per fee head, then the month's TOTAL.

const AUG = 2026 * 12 + 7;
const SEP = 2026 * 12 + 8;

function build() {
  const service = new FinancialReportsService({} as any, {} as any, {} as any);
  const months = new Map([
    [
      101,
      new Map([
        [AUG, { owed: 12000, partial: false, heads: [{ name: 'Tuition', owed: 9000, partial: false }, { name: 'Lab', owed: 3000, partial: false }] }],
        [SEP, { owed: 4000, partial: true, heads: [{ name: 'Tuition', owed: 4000, partial: true }] }],
      ]),
    ],
    [102, new Map([[SEP, { owed: 9000, partial: false, heads: [{ name: 'Tuition', owed: 9000, partial: false }] }]])],
  ]);
  const s = service as any;
  s.loadDefaulterOwedMonths = jest.fn(async () => months);
  s.loadSiblingGrNumbers = jest.fn(async () => new Map());
  s.loadDefaulterFilterNames = jest.fn(async () => ({ campuses: [], classes: [], sections: [], segments: [] }));
  const items = [101, 102].map((cc) => ({
    cc, gr_number: String(cc), student_name: `S${cc}`, campus: 'Gulistan-e-Johar Campus', campus_code: 'GEJ',
    class_id: 16, class_name: 'VII', section: 'A', student_status: 'ENROLLED', category: 'DEFAULTER',
  }));
  return (query: Record<string, unknown>) => s.buildDefaultersStudentReport(items, '2026-10-16', { strip_months: 3, ...query }, 'x');
}

async function sheetOf(file: { buffer: Buffer }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer as any);
  const ws = wb.worksheets[0];
  let hdr = 1;
  while (ws.getCell(hdr, 1).value !== 'S#') hdr++;
  const row = (r: number) => (ws.getRow(r).values as unknown[]).slice(1);
  return { ws, hdr, row };
}

describe('defaulters export: head sub-columns (TAFSD-335)', () => {
  it('puts each month over its head sub-columns and a TOTAL, all numeric', async () => {
    const { ws, hdr, row } = await sheetOf(await build()({ format: 'xlsx', breakdown_by_head: true }));
    const names = row(hdr + 1);
    const augAt = row(hdr).indexOf('AUG');
    expect(names.slice(augAt, augAt + 5)).toEqual(['TUITION', 'LAB', 'TOTAL', 'TUITION', 'TOTAL']);
    expect(row(hdr)[augAt + 3]).toBe('SEP');
    // AUG is one merged cell over its three sub-columns; S# spans both header rows.
    expect(ws.getCell(hdr, augAt + 3).master.address).toBe(ws.getCell(hdr, augAt + 1).address);
    expect(ws.getCell(hdr + 1, 1).master.address).toBe(ws.getCell(hdr, 1).address);

    const first = row(hdr + 2);
    expect(first.slice(augAt, augAt + 5)).toEqual([9000, 3000, 12000, 4000, 4000]);
    expect(ws.getCell(hdr + 2, augAt + 4).numFmt).toBe('"BP "0'); // part-paid head
    const second = row(hdr + 3);
    expect(second.slice(augAt, augAt + 5)).toEqual([undefined, undefined, undefined, 9000, 9000]);

    // TOTAL row sums every sub-column and the defaulting amount.
    const total = row(hdr + 4);
    expect(total.slice(augAt, augAt + 5)).toEqual([9000, 3000, 12000, 13000, 13000]);
    expect(total[row(hdr).indexOf('DEFAULTING AMOUNT')]).toBe(25000);
  });

  it('keeps one header row and one column per month without the breakdown', async () => {
    const { hdr, row } = await sheetOf(await build()({ format: 'xlsx' }));
    expect(row(hdr)).toEqual(expect.arrayContaining(['AUG', 'SEP', 'DEFAULTING AMOUNT']));
    expect(row(hdr + 1)[0]).toBe(1); // data starts straight after
  });

  it('CSV gets the same sub-columns', async () => {
    const file = await build()({ format: 'csv', breakdown_by_head: true });
    const [header, first] = file.buffer.toString('utf8').replace('﻿', '').split('\n');
    expect(header).toContain('AUG TUITION,AUG LAB,AUG TOTAL,SEP TUITION,SEP TOTAL');
    expect(first).toContain('9000,3000,12000,4000,4000');
  });
});
