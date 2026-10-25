import * as ExcelJS from 'exceljs';
import { FinancialReportsService } from './financial-reports.service';
import { __test, displayText, MIN_SCALE, sheetWidthPt, workbookFitsPaper } from './sheet-pdf';

// TAFSD-417: the defaulters PDF is a landscape print of the Excel workbook.

const AUG = 2026 * 12 + 7;
const SEP = 2026 * 12 + 8;

function service(studentCount: number) {
  const s = new FinancialReportsService({} as any, {} as any, {} as any) as any;
  const months = new Map<number, Map<number, unknown>>();
  const items: Array<Record<string, unknown>> = [];
  for (let i = 0; i < studentCount; i++) {
    const cc = 1000 + i;
    months.set(cc, new Map([
      [AUG, { owed: 9000, partial: false, heads: [{ name: 'Tuition', owed: 9000, partial: false }] }],
      [SEP, { owed: 4000, partial: true, heads: [{ name: 'Tuition', owed: 4000, partial: true }] }],
    ]));
    items.push({ cc, gr_number: `G${i}`, student_name: `Student ${i}`, campus: 'Gulistan-e-Johar Campus', campus_code: 'GEJ', class_id: 16, class_name: 'VII', section: 'A', student_status: 'ENROLLED', category: 'DEFAULTER' });
  }
  s.loadDefaulterOwedMonths = jest.fn(async () => months);
  s.loadSiblingGrNumbers = jest.fn(async () => new Map());
  s.loadDefaulterContacts = jest.fn(async () => new Map());
  s.loadDefaulterFilterNames = jest.fn(async () => ({ campuses: [], classes: [], sections: [], segments: [] }));
  s.formatPktDateTime = jest.fn(() => '22 OCT 2026, 10:00 PM');
  return (query: Record<string, unknown>) => s.buildDefaultersStudentReport(items, '2026-10-16', { strip_months: 3, ...query }, 'defaulters');
}

describe('defaulters sheet PDF (TAFSD-417)', () => {
  it('prints the sheet as a PDF named for its paper', async () => {
    const file = await service(5)({ format: 'pdf', paper: 'A4' });
    expect(file.contentType).toBe('application/pdf');
    expect(file.filename).toBe('defaulters-A4.pdf');
    expect(Buffer.isBuffer(file.buffer)).toBe(true);
  });

  it('goes to A3 when asked', async () => {
    expect((await service(5)({ format: 'pdf', paper: 'A3' })).filename).toBe('defaulters-A3.pdf');
  });

  it('goes to A3 when the sheet is too wide for A4, whatever was asked', async () => {
    const file = await service(5)({ format: 'pdf', paper: 'A4', months_back: 24, breakdown_by_head: true });
    expect(file.filename).toBe('defaulters-A3.pdf');
  });

  it('repeats the title block and header on every page, and numbers the pages', async () => {
    const xlsx = await service(80)({ format: 'xlsx' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.buffer as any);
    const pages = __test.layoutSheet(wb.worksheets[0], 'A4');
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      const texts = p.cells.map((c) => c.text);
      expect(texts).toContain("AT A GLANCE CONSOLIDATED DEFAULTERS' LIST");
      expect(texts).toContain('STUDENT NAME');
      expect(p.totalPages).toBe(pages.length);
      // Nothing runs into the footer.
      for (const c of p.cells) expect(c.top + c.height).toBeLessThanOrEqual(595.28 - 20 - 16 + 0.01);
    }
    // Every student lands on exactly one page.
    const students = pages.flatMap((p) => p.cells.map((c) => c.text)).filter((t) => /^Student \d+$/i.test(t));
    expect(new Set(students).size).toBe(80);
    expect(students.length).toBe(80);
  });

  it('formats numbers the way Excel shows them', () => {
    const ws = new ExcelJS.Workbook().addWorksheet('x');
    const c = ws.getCell('A1');
    c.value = 4000;
    c.numFmt = '"BP "0';
    expect(displayText(c)).toBe('BP 4000');
    c.numFmt = '0.00';
    expect(displayText(c)).toBe('4000.00');
    c.numFmt = '0';
    expect(displayText(c)).toBe('4000');
  });

  it('A4 refuses only what would shrink past the minimum', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('x');
    ws.getColumn(1).width = 10;
    expect(workbookFitsPaper(wb, 'A4')).toBe(true);
    for (let c = 1; c <= 40; c++) ws.getColumn(c).width = 10;
    expect(sheetWidthPt(ws) * MIN_SCALE).toBeGreaterThan(801);
    expect(workbookFitsPaper(wb, 'A4')).toBe(false);
  });
});
