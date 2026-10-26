import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import {
  displayText,
  type SheetPaper,
  workbookFitsPaper,
  workbookToPdf,
} from './sheet-pdf';
import {
  type StandardFont,
  textWidthPt,
  wrappedLineCount,
} from './standard-font-widths';

/**
 * TAFSD-425: what every school-format sheet shares — the defaulters sheet
 * (buildStudentMonthReport) and the Fee Heads / Deposits sheets
 * (school-report-sheet.ts) — so a change to the title block, row fitting or
 * the PDF lands on all of them at once.
 */

export const SHEET_SERIF = 'Times New Roman';

/** One merged, centred, bold line across the sheet. Returns the next free row. */
export function writeBanner(
  sheet: ExcelJS.Worksheet,
  lastCol: number,
  line: number,
  text: string,
  size: number,
  height: number,
): number {
  if (lastCol > 1) sheet.mergeCells(line, 1, line, lastCol);
  const cell = sheet.getCell(line, 1);
  cell.value = text;
  cell.font = { name: SHEET_SERIF, bold: true, size };
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  sheet.getRow(line).height = height;
  return line + 1;
}

/**
 * A column header as the sheets print it: capitals, with room to wrap after a
 * slash ("REGISTRATION/ ENROLLMENT FEE"), which otherwise makes one word too
 * long for any column.
 */
export const headerText = (text: string) =>
  text.toUpperCase().replace(/\/(?=\S)/g, '/ ');

export interface SheetTitle {
  school: string;
  /** "CLASSES: VIII, AS LEVEL", only when the sheet mixes both schools. */
  classesLine?: string | null;
  /** "AT A GLANCE CONSOLIDATED DEFAULTERS' LIST", "FEE HEADS REPORT — BY FEE DATE" … */
  title: string;
  campus: string;
  session: string;
}

/**
 * The title block at the top of every school sheet (TAFSD-289/338), sized up
 * in TAFSD-417 so it reads from across the room. Returns the next free row.
 */
export function writeTitleBlock(
  sheet: ExcelJS.Worksheet,
  lastCol: number,
  line: number,
  t: SheetTitle,
): number {
  line = writeBanner(sheet, lastCol, line, t.school, 26, 40);
  if (t.classesLine)
    line = writeBanner(sheet, lastCol, line, t.classesLine, 15, 22);
  line = writeBanner(sheet, lastCol, line, t.title, 22, 32);
  line = writeBanner(sheet, lastCol, line, t.campus, 18, 26);
  return writeBanner(sheet, lastCol, line, t.session, 16, 22);
}

const fontOf = (font: Partial<ExcelJS.Font> | undefined): StandardFont =>
  /times|serif/i.test(font?.name ?? '')
    ? font?.bold
      ? 'Times-Bold'
      : 'Times-Roman'
    : font?.bold
      ? 'Helvetica-Bold'
      : 'Helvetica';

/** A column's printable width in points: Excel's trunc(w·7+5) pixels, less the cell's padding. */
const innerWidthPt = (width: number) => Math.floor(width * 7 + 5) * 0.75 - 4;
/** The Excel width whose printable width is `pt`. */
const widthForPt = (pt: number) => ((pt + 4) / 0.75 - 5) / 7;
/** How far a column may grow to fit its longest number or body word. */
const MAX_FIT_WIDTH = 18;
/**
 * How far a header word may grow it. Lower: a sheet with twenty fee head
 * columns can't give each the width of "REGISTRATION"; past this the header
 * wraps (Excel) or shrinks to fit (PDF) instead.
 */
const MAX_HEADER_FIT_WIDTH = 12;

/**
 * TAFSD-425: fits a finished sheet to its contents, the last step of every
 * school sheet. First each column grows (up to MAX_FIT_WIDTH) until its
 * longest number and longest single word — "REGISTRATION", "1,399,405.00" —
 * fit at their own size, since neither can wrap; then every row from
 * `fromRow` grows to fit its wrapped text. Merged cells (banners, group
 * headings, TOTAL labels) don't size columns.
 */
export function fitSheetToText(
  sheet: ExcelJS.Worksheet,
  fromRow: number,
  headerTo = fromRow,
): void {
  const need = new Map<number, number>();
  sheet.eachRow((row, r) => {
    if (r < fromRow) return;
    const cap = r <= headerTo ? MAX_HEADER_FIT_WIDTH : MAX_FIT_WIDTH;
    row.eachCell((cell, col) => {
      if (cell.isMerged) return;
      const text = displayText(cell);
      if (!text) return;
      const font = fontOf(cell.font);
      const size = cell.font?.size ?? 11;
      const widest = Math.max(
        ...text.split(/\s+/).map((word) => textWidthPt(word, font, size)),
      );
      const wanted = Math.min(cap, Math.ceil(widthForPt(widest) * 2) / 2);
      need.set(col, Math.max(need.get(col) ?? 0, wanted));
    });
  });
  for (const [col, wanted] of need) {
    const column = sheet.getColumn(col);
    if (wanted > (column.width ?? 9)) column.width = wanted;
  }
  for (let r = fromRow; r <= sheet.rowCount; r++) fitRowToText(sheet, r);
}

/**
 * Grows a row to fit its wrapped text. Excel never resizes a row for text it
 * didn't type itself, so a long name, sibling list or fee head would be cut
 * off. Merged cells are left alone (banners have their own heights).
 */
export function fitRowToText(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  minHeight = 0,
): void {
  const row = sheet.getRow(rowNumber);
  const before = row.height;
  let height = Math.max(before ?? 15, minHeight);
  row.eachCell((cell, col) => {
    if (
      !cell.alignment?.wrapText ||
      cell.isMerged ||
      typeof cell.value !== 'string' ||
      !cell.value
    )
      return;
    const size = cell.font?.size ?? 11;
    const lines = wrappedLineCount(
      cell.value,
      fontOf(cell.font),
      size,
      innerWidthPt(sheet.getColumn(col).width ?? 9),
    );
    height = Math.max(height, lines * size * 1.2 + 6);
  });
  // Only ever grows a row; one with nothing to fit keeps Excel's default.
  if (height > (before ?? 15)) row.height = Math.ceil(height);
}

export type SheetExportFile = {
  buffer: Buffer;
  filename: string;
  contentType: string;
};

/**
 * The finished workbook as Excel, or (TAFSD-417/425) as a landscape PDF print
 * of that same workbook on the paper asked for. A sheet too wide for A4 goes
 * on A3 whatever was asked, and the filename says which; one too wide to read
 * even on A3 is refused with `tooWideHint` saying what to cut.
 */
export async function schoolWorkbookFile(
  workbook: ExcelJS.Workbook,
  query: { format?: string; paper?: SheetPaper },
  basename: string,
  title: string,
  tooWideHint = 'Narrow the date range or filters, or export Excel.',
): Promise<SheetExportFile> {
  if (query.format === 'pdf') {
    if (!workbookFitsPaper(workbook, 'A3')) {
      throw new BadRequestException(
        `Too many columns to print even on A3. ${tooWideHint} Excel has no such limit.`,
      );
    }
    const paper: SheetPaper =
      query.paper === 'A3' || !workbookFitsPaper(workbook, 'A4') ? 'A3' : 'A4';
    return {
      buffer: await workbookToPdf(workbook, paper, title),
      filename: `${basename}-${paper}.pdf`,
      contentType: 'application/pdf',
    };
  }
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    filename: `${basename}.xlsx`,
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

/** The sheet for an export with nothing in it: the message on a line wide enough to read. */
export function writeEmptySheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  message: string,
): void {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.getCell('A1').value = message;
  sheet.getColumn(1).width = 60;
}
