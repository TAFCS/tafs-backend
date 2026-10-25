import * as ExcelJS from 'exceljs';
import { fitSheetToText, headerText, schoolWorkbookFile, writeTitleBlock } from './school-sheet-common';
import { displayText } from './sheet-pdf';
import { writeSchoolSheets } from './school-report-sheet';

// TAFSD-425: the pieces every school-format sheet shares.

describe('school sheet common (TAFSD-425)', () => {
  it('writes the title block at one set of sizes', () => {
    const ws = new ExcelJS.Workbook().addWorksheet('x');
    const next = writeTitleBlock(ws, 5, 1, { school: 'S', title: 'T', campus: 'C', session: 'SESSION 2026–2027' });
    expect(next).toBe(5);
    expect([1, 2, 3, 4].map((r) => ws.getCell(r, 1).font.size)).toEqual([26, 22, 18, 16]);
    const withClasses = new ExcelJS.Workbook().addWorksheet('y');
    expect(writeTitleBlock(withClasses, 5, 1, { school: 'S', classesLine: 'CLASSES: VIII', title: 'T', campus: 'C', session: 'S' })).toBe(6);
  });

  it('lets a header wrap after a slash', () => {
    expect(headerText('Registration/Enrollment Fee')).toBe('REGISTRATION/ ENROLLMENT FEE');
    expect(headerText('Oct / Nov')).toBe('OCT / NOV');
  });

  it('widens a column to its longest number, and grows a row for wrapped text', () => {
    const ws = new ExcelJS.Workbook().addWorksheet('x');
    ws.getColumn(1).width = 6;
    ws.getColumn(2).width = 12;
    const n = ws.getCell('A1');
    n.value = 1399405;
    n.numFmt = '0.00';
    n.font = { name: 'Times New Roman', bold: true, size: 12 };
    const t = ws.getCell('B1');
    t.value = 'MUHAMMAD IBRAHIM BIN SAQLAIN AHMED';
    t.font = { name: 'Times New Roman', size: 11 };
    t.alignment = { wrapText: true };
    ws.getRow(1).height = 22;
    fitSheetToText(ws, 1);
    expect(ws.getColumn(1).width).toBeGreaterThan(6);
    expect(ws.getColumn(2).width).toBe(12);
    expect(ws.getRow(1).height).toBeGreaterThan(22);
    // A row with nothing to fit keeps Excel's default height.
    ws.getCell('A3').value = 'x';
    fitSheetToText(ws, 1);
    expect(ws.getRow(3).height).toBeUndefined();
  });

  it('caps how far a header word widens a column', () => {
    const ws = new ExcelJS.Workbook().addWorksheet('x');
    ws.getColumn(1).width = 10;
    ws.getCell('A1').value = 'REGISTRATIONENROLLMENTOLEVEL';
    ws.getCell('A1').font = { name: 'Times New Roman', bold: true, size: 10 };
    fitSheetToText(ws, 1, 1);
    expect(ws.getColumn(1).width).toBe(12);
  });

  it('shows money the way Excel does', () => {
    const ws = new ExcelJS.Workbook().addWorksheet('x');
    const c = ws.getCell('A1');
    c.value = 1072190;
    c.numFmt = '#,##0';
    expect(displayText(c)).toBe('1,072,190');
    c.value = 1072190.5;
    c.numFmt = '#,##0.00';
    expect(displayText(c)).toBe('1,072,190.50');
  });

  const sheetWith = (columns: number) => {
    const wb = new ExcelJS.Workbook();
    writeSchoolSheets(
      wb,
      [{ tab: 'GEJ', campus: 'GULISTAN-E-JOHAR CAMPUS', rows: [{ a: 'x', b: 100 }] }],
      {
        reportTitle: 'FEE HEADS REPORT — BY FEE DATE',
        heading: { school: 'THE AMERICAN FOUNDATION SCHOOL', classesLine: null, session: 'SESSION 2026–2027' },
        periodLine: 'FROM 1 AUGUST 2026 TO 30 NOVEMBER 2026',
        filterLines: [],
        exportDate: '2026-10-26',
        columns: Array.from({ length: columns }, (_, i) => ({ header: `C${i}`, key: i === 0 ? 'a' : 'b', width: 12, money: i > 0, total: i > 0 })),
      },
    );
    return wb;
  };

  it('prints a school sheet as a PDF on the paper asked for, A3 when too wide, refused past A3', async () => {
    expect((await schoolWorkbookFile(sheetWith(5), { format: 'pdf', paper: 'A4' }, 'fd', 'T')).filename).toBe('fd-A4.pdf');
    expect((await schoolWorkbookFile(sheetWith(5), { format: 'pdf', paper: 'A3' }, 'fd', 'T')).filename).toBe('fd-A3.pdf');
    expect((await schoolWorkbookFile(sheetWith(20), { format: 'pdf', paper: 'A4' }, 'fd', 'T')).filename).toBe('fd-A3.pdf');
    await expect(schoolWorkbookFile(sheetWith(40), { format: 'pdf' }, 'fd', 'T', 'Narrow it.')).rejects.toThrow(
      'Too many columns to print even on A3. Narrow it. Excel has no such limit.',
    );
    expect((await schoolWorkbookFile(sheetWith(40), { format: 'xlsx' }, 'fd', 'T')).filename).toBe('fd.xlsx');
  });
});
