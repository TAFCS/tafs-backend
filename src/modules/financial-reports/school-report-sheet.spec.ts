import * as ExcelJS from 'exceljs';
import { periodLine, writeSchoolSheets } from './school-report-sheet';

describe('school-report-sheet (TAFSD-268)', () => {
  it('period line reads in words', () => {
    expect(periodLine('2026-08-01', '2026-10-31')).toBe('FROM 1 AUGUST 2026 TO 31 OCTOBER 2026');
    expect(periodLine('2026-10-01', '2026-10-01')).toBe('ON 1 OCTOBER 2026');
  });

  it('writes the title block, an S# column and a TOTAL under summed columns only', async () => {
    const wb = new ExcelJS.Workbook();
    writeSchoolSheets(
      wb,
      [{ tab: 'GEJ', campus: 'GULISTAN-E-JAUHAR CAMPUS', rows: [{ name: 'A', amount: 100.5, heads: 2 }, { name: 'B', amount: 200, heads: 3 }] }],
      {
        reportTitle: 'FEE HEADS REPORT',
        heading: { school: 'THE AMERICAN FOUNDATION SCHOOL', classesLine: null, session: 'SESSION 2026–2027' },
        periodLine: 'ON 1 OCTOBER 2026',
        filterLines: ['ALL STUDENTS'],
        exportDate: '2026-10-12',
        generatedLine: 'GENERATED ON 12-10-2026 10:00 AM BY AAWAIZ ALI (aawaiz.ali)',
        columns: [
          { header: 'Name', key: 'name', width: 20 },
          { header: 'Heads', key: 'heads', width: 8, total: true },
          { header: 'Amount', key: 'amount', width: 12, total: true, money: true },
        ],
      },
    );
    const ws = wb.worksheets[0];
    const col = (r: number) => (ws.getRow(r).values as unknown[]).slice(1);
    expect(ws.getCell(1, 1).value).toBe('THE AMERICAN FOUNDATION SCHOOL');
    expect(ws.getCell(2, 1).value).toBe('FEE HEADS REPORT');
    expect(ws.getCell(3, 1).value).toBe('GULISTAN-E-JAUHAR CAMPUS');
    const header = [...Array(ws.rowCount).keys()].map((i) => i + 1).find((r) => ws.getCell(r, 1).value === 'S#')!;
    expect(col(header)).toEqual(['S#', 'NAME', 'HEADS', 'AMOUNT']);
    expect(col(header + 1)).toEqual([1, 'A', 2, 100.5]);
    const total = ws.getRow(header + 3);
    expect(total.getCell(1).value).toBe('TOTAL');
    expect(total.getCell(3).value).toBe(5);
    expect(total.getCell(4).value).toBe(300.5);
    expect(total.getCell(4).numFmt).toBe('#,##0.00');
  });

  it('matches the defaulters sheet: bigger title, GENERATED ON line under DAY / DATE (TAFSD-341)', async () => {
    const wb = new ExcelJS.Workbook();
    writeSchoolSheets(
      wb,
      [{ tab: 'GEJ', campus: 'GULISTAN-E-JAUHAR CAMPUS', rows: [{ amount: 100 }] }],
      {
        reportTitle: 'FEE HEADS REPORT — BY FEE DATE',
        heading: { school: 'THE AMERICAN FOUNDATION SCHOOL', classesLine: null, session: 'SESSION 2026–2027' },
        periodLine: 'ON 1 OCTOBER 2026',
        filterLines: [],
        exportDate: '2026-10-12',
        generatedLine: 'GENERATED ON 12-10-2026 10:00 AM BY AAWAIZ ALI (aawaiz.ali)',
        columns: [{ header: 'Amount', key: 'amount', width: 12, total: true, money: true }],
      },
    );
    const ws = wb.worksheets[0];
    expect(ws.getCell(1, 1).font.size).toBe(20);
    expect(ws.getCell(2, 1).font.size).toBe(17);
    const lines = [...Array(ws.rowCount).keys()].map((i) => ws.getCell(i + 1, 1).value);
    const day = lines.indexOf('DAY :MONDAY');
    expect(lines.slice(day, day + 3)).toEqual([
      'DAY :MONDAY',
      'DATE : OCTOBER 12, 2026',
      'GENERATED ON 12-10-2026 10:00 AM BY AAWAIZ ALI (aawaiz.ali)',
    ]);
  });
});
