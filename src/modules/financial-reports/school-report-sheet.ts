import * as ExcelJS from 'exceljs';
import type { DefaulterSheetHeading } from './defaulter-sheet-heading';

/**
 * TAFSD-268: the school's paper-sheet layout for the Fee Heads and Deposits
 * Excel exports, matching the defaulters sheet so the three read as one set:
 * school name, report title, campus, session, DAY / DATE, the filters in words,
 * then a boxed table with S# and a TOTAL row under every summed column.
 */

export interface SchoolSheetColumn {
  header: string;
  key: string;
  width: number;
  /** Summed into the TOTAL row (money and counts). */
  total?: boolean;
  /** Money: shown with thousands separators. */
  money?: boolean;
}

export interface SchoolSheet {
  /** Worksheet tab name. */
  tab: string;
  /** The campus line as printed: "GULISTAN-E-JAUHAR CAMPUS", or "ALL CAMPUSES". */
  campus: string;
  rows: Array<Record<string, string | number>>;
}

export interface SchoolSheetOptions {
  /** "FEE HEADS REPORT", "DEPOSITS REPORT". */
  reportTitle: string;
  heading: DefaulterSheetHeading;
  /** "FROM 1 AUGUST 2026 TO 31 OCTOBER 2026". */
  periodLine: string;
  filterLines: string[];
  /** YYYY-MM-DD, for the DAY / DATE lines. */
  exportDate: string;
  columns: SchoolSheetColumn[];
}

const SERIF = 'Times New Roman';
const thin: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF000000' } };
const box: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };
/** Whole rupees normally; two decimals only for a column that actually has paisa. */
const MONEY_FMT = '#,##0';
const MONEY_FMT_DECIMAL = '#,##0.00';

/** Writes one worksheet per entry of `sheets` into `workbook`. */
export function writeSchoolSheets(
  workbook: ExcelJS.Workbook,
  sheets: SchoolSheet[],
  opts: SchoolSheetOptions,
): void {
  const [y, m, d] = opts.exportDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayLine = `DAY :${date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toUpperCase()}`;
  const dateLine = `DATE : ${date
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .toUpperCase()}`;

  const usedTabs = new Set<string>();
  for (const sheetData of sheets) {
    const sheet = workbook.addWorksheet(uniqueTab(sheetData.tab, usedTabs));
    const columns: SchoolSheetColumn[] = [{ header: 'S#', key: '__sno', width: 5 }, ...opts.columns];
    const lastCol = columns.length;

    let line = 1;
    const banner = (text: string, size: number, height: number) => {
      if (lastCol > 1) sheet.mergeCells(line, 1, line, lastCol);
      const cell = sheet.getCell(line, 1);
      cell.value = text;
      cell.font = { name: SERIF, bold: true, size };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      sheet.getRow(line).height = height;
      line++;
    };
    banner(opts.heading.school, 16, 28);
    if (opts.heading.classesLine) banner(opts.heading.classesLine, 11, 18);
    banner(opts.reportTitle, 14, 22);
    banner(sheetData.campus, 13, 20);
    banner(opts.heading.session, 12, 18);

    line++;
    for (const text of [dayLine, dateLine]) {
      const cell = sheet.getCell(line++, 1);
      cell.value = text;
      cell.font = { name: 'Arial', bold: true, size: 9 };
    }
    line++;
    banner(opts.periodLine, 13, 20);
    for (const text of opts.filterLines) banner(text, 11, 16);

    const HEADER_ROW = line;
    const headerRow = sheet.getRow(HEADER_ROW);
    columns.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.header.toUpperCase();
      cell.font = { name: SERIF, bold: true, size: 10 };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = box;
      sheet.getColumn(i + 1).width = col.width;
    });
    headerRow.height = 30;

    const moneyFmt = new Map(
      columns
        .filter((c) => c.money)
        .map((c) => [
          c.key,
          sheetData.rows.some((r) => typeof r[c.key] === 'number' && !Number.isInteger(r[c.key]))
            ? MONEY_FMT_DECIMAL
            : MONEY_FMT,
        ]),
    );
    const sums = new Map<string, number>();
    let rowIdx = HEADER_ROW + 1;
    sheetData.rows.forEach((data, i) => {
      const row = sheet.getRow(rowIdx++);
      columns.forEach((col, c) => {
        const cell = row.getCell(c + 1);
        const value = col.key === '__sno' ? i + 1 : data[col.key];
        cell.value = value === undefined || value === null ? '' : value;
        if (col.money && typeof value === 'number') cell.numFmt = moneyFmt.get(col.key)!;
        if (col.total && typeof value === 'number') sums.set(col.key, (sums.get(col.key) ?? 0) + value);
        cell.border = box;
        cell.font = { name: SERIF, size: 10 };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: col.width >= 20 };
      });
      row.height = 18;
    });

    // TOTAL under every summed column, labelled in the columns before the first.
    const totalIdx = columns.map((col, i) => (col.total ? i + 1 : 0)).filter(Boolean);
    if (totalIdx.length && sheetData.rows.length) {
      const totalRow = sheet.getRow(rowIdx);
      const first = totalIdx[0];
      if (first > 1) {
        const labelFrom = Math.max(1, first - 3);
        if (first - 1 > labelFrom) sheet.mergeCells(rowIdx, labelFrom, rowIdx, first - 1);
        const label = totalRow.getCell(labelFrom);
        label.value = 'TOTAL';
        label.font = { name: SERIF, bold: true, size: 12 };
        label.alignment = { horizontal: 'center', vertical: 'middle' };
        for (let c = labelFrom; c < first; c++) totalRow.getCell(c).border = box;
      }
      for (const idx of totalIdx) {
        const col = columns[idx - 1];
        const cell = totalRow.getCell(idx);
        cell.value = Math.round((sums.get(col.key) ?? 0) * 100) / 100;
        cell.numFmt = col.money ? moneyFmt.get(col.key)! : '0';
        cell.font = { name: SERIF, bold: true, size: 11 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = box;
      }
      totalRow.height = 22;
    }

    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: HEADER_ROW }];
    sheet.pageSetup = {
      paperSize: 9, // A4
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}`,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    };
  }
}

/** "FROM 1 AUGUST 2026 TO 31 OCTOBER 2026" (or "ON …" for a single day). */
export function periodLine(fromDate: string, toDate: string): string {
  const fmt = (v: string) => {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d))
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      .toUpperCase();
  };
  return fromDate === toDate ? `ON ${fmt(fromDate)}` : `FROM ${fmt(fromDate)} TO ${fmt(toDate)}`;
}

/** Excel tab names: ≤31 chars, no []:/?\*, unique within the workbook. */
function uniqueTab(name: string, used: Set<string>): string {
  const base = (name.replace(/[[\]:/?\\*]/g, ' ').trim() || 'Sheet').slice(0, 31);
  let tab = base;
  for (let n = 2; used.has(tab.toLowerCase()); n++) tab = `${base.slice(0, 28)} ${n}`;
  used.add(tab.toLowerCase());
  return tab;
}
