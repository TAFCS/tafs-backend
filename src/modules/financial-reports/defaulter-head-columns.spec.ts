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
  s.loadDefaulterContacts = jest.fn(async () => new Map([[101, ['FATHER 0312-2244523', 'MOTHER 0300-1234567']]]));
  s.loadDefaulterFilterNames = jest.fn(async () => ({ campuses: [], classes: [], sections: [], segments: [] }));
  const items = [101, 102].map((cc) => ({
    cc, gr_number: String(cc), student_name: `S${cc}`, campus: 'Gulistan-e-Johar Campus', campus_code: 'GEJ',
    class_id: 16, class_name: 'VII', section: 'A', student_status: 'ENROLLED', category: 'DEFAULTER',
  }));
  return (query: Record<string, unknown>, by?: Record<string, unknown>) =>
    s.buildDefaultersStudentReport(items, '2026-10-16', { strip_months: 3, ...query }, 'x', by);
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

describe('defaulters export: group by (TAFSD-337)', () => {
  function grouped() {
    const service = new FinancialReportsService({} as any, {} as any, {} as any);
    const s = service as any;
    const months = new Map<number, Map<number, any>>();
    const items = [
      { cc: 1, class_id: 16, class_name: 'VII', section: 'B', owed: 100 },
      { cc: 2, class_id: 15, class_name: 'VI', section: 'A', owed: 200 },
      { cc: 3, class_id: 16, class_name: 'VII', section: 'A', owed: 300 },
    ].map((r) => {
      months.set(r.cc, new Map([[AUG, { owed: r.owed, partial: false, heads: [{ name: 'Tuition', owed: r.owed, partial: false }] }]]));
      return { ...r, gr_number: String(r.cc), student_name: `S${r.cc}`, campus: 'GEJ', campus_code: 'GEJ', student_status: 'ENROLLED', category: 'DEFAULTER' };
    });
    s.loadDefaulterOwedMonths = jest.fn(async () => months);
    s.loadSiblingGrNumbers = jest.fn(async () => new Map());
    s.loadDefaulterContacts = jest.fn(async () => new Map());
    s.loadDefaulterFilterNames = jest.fn(async () => ({ campuses: new Map(), classes: new Map(), sections: new Map(), segments: new Map() }));
    s.loadDefaulterFamilies = jest.fn(async () => new Map([[1, { id: 9, household_name: 'Family of Zaidi' }], [3, { id: 9, household_name: 'Family of Zaidi' }], [2, { id: 4, household_name: 'Family of Ahmed' }]]));
    return (query: Record<string, unknown>) => s.buildDefaultersStudentReport(items, '2026-10-16', { strip_months: 3, format: 'xlsx', ...query }, 'x');
  }
  const col1 = async (query: Record<string, unknown>) => {
    const { ws, hdr } = await sheetOf(await grouped()(query));
    const out: unknown[] = [];
    for (let r = hdr + 1; r <= ws.rowCount; r++) {
      const v = ws.getCell(r, 1).value;
      const amount = ws.getCell(r, ws.getRow(hdr).cellCount - 1).value;
      out.push(typeof v === 'string' ? v : v == null && amount != null ? `= ${amount}` : v ?? '');
    }
    return out;
  };

  it('orders classes by level with heading, S# restart, subtotal and a blank row', async () => {
    expect(await col1({ group_by: 'class' })).toEqual([
      'CLASS VI · 1 STUDENT', 1, '= 200', '',
      'CLASS VII · 2 STUDENTS', 1, 2, '= 400', '',
      '= 600',
    ]);
  });

  it('groups by section and by family', async () => {
    expect((await col1({ group_by: 'section' })).filter((v) => typeof v === 'string' && /·/.test(v))).toEqual([
      'VI A · 1 STUDENT', 'VII A · 1 STUDENT', 'VII B · 1 STUDENT',
    ]);
    expect((await col1({ group_by: 'family' })).filter((v) => typeof v === 'string' && /·/.test(v))).toEqual([
      'FAMILY OF AHMED · #4 · 1 STUDENT', 'FAMILY OF ZAIDI · #9 · 2 STUDENTS',
    ]);
  });
});

describe('defaulters export: generated by (TAFSD-338)', () => {
  it('writes when and by whom under DAY / DATE, with the full name and username', async () => {
    const { ws, hdr } = await sheetOf(
      await build()({ format: 'xlsx' }, { sub: 'u1', username: 'aawaiz', fullName: 'Aawaiz Ali' }),
    );
    const lines: string[] = [];
    for (let r = 1; r < hdr; r++) lines.push(String(ws.getCell(r, 1).value ?? ''));
    const generated = lines.find((l) => l.startsWith('GENERATED ON '));
    expect(generated).toMatch(/^GENERATED ON \d{2}-\d{2}-\d{4} \d{2}:\d{2} (AM|PM) BY AAWAIZ ALI \(aawaiz\)$/);
    expect(lines.indexOf(generated!)).toBe(lines.findIndex((l) => l.startsWith('DATE :')) + 1);
  });
});

describe('defaulters export: contact column (TAFSD-340)', () => {
  it('lists guardian numbers one per line after STATUS, growing the row', async () => {
    const { ws, hdr, row } = await sheetOf(await build()({ format: 'xlsx' }));
    const at = row(hdr).indexOf('CONTACT');
    expect(row(hdr)[at - 1]).toBe('STATUS');
    expect(row(hdr + 1)[at]).toBe('FATHER 0312-2244523\nMOTHER 0300-1234567');
    expect(ws.getRow(hdr + 1).height).toBeGreaterThan(22);
    expect(row(hdr + 2)[at]).toBeFalsy(); // nothing on file: blank
  });

  it('skips the lookup when the column is not picked', async () => {
    const service = new FinancialReportsService({} as any, {} as any, {} as any);
    const s = service as any;
    s.loadDefaulterOwedMonths = jest.fn(async () => new Map());
    s.loadSiblingGrNumbers = jest.fn(async () => new Map());
    s.loadDefaulterFilterNames = jest.fn(async () => ({}));
    s.loadDefaulterContacts = jest.fn(async () => new Map());
    await s.buildDefaultersStudentReport([{ cc: 1 }], '2026-10-16', { format: 'csv', columns: ['cc', 'name'] }, 'x');
    expect(s.loadDefaulterContacts).not.toHaveBeenCalled();
  });
});
