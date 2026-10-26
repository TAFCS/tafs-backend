import * as ExcelJS from 'exceljs';
import type { DefaulterSheetHeading } from './defaulter-sheet-heading';
import {
  fitSheetToText,
  headerText,
  SHEET_SERIF,
  writeBanner,
  writeTitleBlock,
} from './school-sheet-common';

/**
 * TAFSD-268: the school's paper-sheet layout for the Fee Heads and Deposits
 * Excel exports, matching the defaulters sheet so the three read as one set:
 * school name, report title, campus, session, DAY / DATE, the filters in words,
 * then a boxed table with S# and a TOTAL row under every summed column.
 *
 * TAFSD-341: type sizes, row heights and the GENERATED ON line follow the
 * defaulters sheet as it stands after TAFSD-338 (buildStudentMonthReport).
 */

export interface SchoolSheetColumn {
  header: string;
  key: string;
  width: number;
  /** Summed into the TOTAL row (money and counts). */
  total?: boolean;
  /** Money: shown with thousands separators. */
  money?: boolean;
  /**
   * A label over a run of adjacent columns sharing it, on a second header row
   * ("BILLED" over TUITION | LAB | TOTAL), as the defaulters sheet puts a month
   * over its fee heads (TAFSD-335). Other columns span both header rows.
   */
  group?: string;
}

/** A titled run of rows with its own SUBTOTAL, then a blank row (TAFSD-337). */
export interface SchoolSheetGroup {
  /** "CLASS VII" — the row count is appended. */
  label: string;
  rows: Array<Record<string, string | number>>;
}

export interface SchoolSheet {
  /** Worksheet tab name. */
  tab: string;
  /** The campus line as printed: "GULISTAN-E-JAUHAR CAMPUS", or "ALL CAMPUSES". */
  campus: string;
  rows: Array<Record<string, string | number>>;
  /** Overrides opts.columns for this sheet (head columns differ by campus). */
  columns?: SchoolSheetColumn[];
  /** Write the rows in these groups instead of one run; `rows` must be their concatenation. */
  groups?: SchoolSheetGroup[];
  /** "FEE DATE" / "FEE DATES": what one row is, for the group headings. */
  rowNoun?: [string, string];
  /**
   * Numbers as the defaulters sheet prints them (TAFSD-341): plain whole
   * numbers in the body, two decimals on TOTAL / SUBTOTAL, no separators.
   */
  defaulterNumbers?: boolean;
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
  /** "GENERATED ON 22-10-2026 10:00 PM BY AAWAIZ ALI (aawaiz.ali)", under DAY / DATE (TAFSD-338). */
  generatedLine?: string;
  columns: SchoolSheetColumn[];
}

const SERIF = SHEET_SERIF;
const thin: Partial<ExcelJS.Border> = {
  style: 'thin',
  color: { argb: 'FF000000' },
};
const box: Partial<ExcelJS.Borders> = {
  top: thin,
  left: thin,
  bottom: thin,
  right: thin,
};
/** Whole rupees normally; two decimals only for a column that actually has paisa. */
const MONEY_FMT = '#,##0';
const MONEY_FMT_DECIMAL = '#,##0.00';

/** Writes one worksheet per entry of `sheets` into `workbook`. */
export function writeSchoolSheets(
  workbook: ExcelJS.Workbook,
  sheets: SchoolSheet[],
  opts: SchoolSheetOptions,
): void {
  const { dayLine, dateLine } = dayDateLines(opts.exportDate);

  const usedTabs = new Set<string>();
  for (const sheetData of sheets) {
    const sheet = workbook.addWorksheet(uniqueTab(sheetData.tab, usedTabs));
    const columns: SchoolSheetColumn[] = [
      { header: 'S#', key: '__sno', width: 5 },
      ...(sheetData.columns ?? opts.columns),
    ];
    const lastCol = columns.length;

    // TAFSD-425: the title block every school sheet shares.
    let line = writeTitleBlock(sheet, lastCol, 1, {
      school: opts.heading.school,
      classesLine: opts.heading.classesLine,
      title: opts.reportTitle,
      campus: sheetData.campus,
      session: opts.heading.session,
    });
    const banner = (text: string, size: number, height: number) => {
      line = writeBanner(sheet, lastCol, line, text, size, height);
    };

    line++;
    for (const text of [
      dayLine,
      dateLine,
      ...(opts.generatedLine ? [opts.generatedLine] : []),
    ]) {
      const cell = sheet.getCell(line, 1);
      cell.value = text;
      cell.font = { name: 'Arial', bold: true, size: 11 };
      sheet.getRow(line++).height = 16;
    }
    line++;
    banner(opts.periodLine, 14, 22);
    for (const text of opts.filterLines) banner(text, 12, 18);

    // Grouped columns get two header rows: the group over its sub-columns, and
    // their names under it. Other columns span both.
    const HEADER_ROW = line;
    const twoRowHeader = columns.some((col) => col.group);
    const HEADER_LAST = twoRowHeader ? HEADER_ROW + 1 : HEADER_ROW;
    const styleHeader = (cell: ExcelJS.Cell, text: string, size: number) => {
      cell.value = headerText(text);
      cell.font = { name: SERIF, bold: true, size };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      cell.border = box;
    };
    columns.forEach((col, i) => {
      const c = i + 1;
      sheet.getColumn(c).width = col.width;
      if (!col.group) {
        if (twoRowHeader) {
          sheet.getCell(HEADER_LAST, c).border = box;
          sheet.mergeCells(HEADER_ROW, c, HEADER_LAST, c);
        }
        styleHeader(
          sheet.getCell(HEADER_ROW, c),
          col.header,
          col.money ? 11 : 13,
        );
        return;
      }
      // One size under the defaulters' 10: a fee date sheet has twenty of these (TAFSD-425).
      styleHeader(sheet.getCell(HEADER_LAST, c), col.header, 9);
      if (columns[i - 1]?.group === col.group) return;
      let end = i;
      while (columns[end + 1]?.group === col.group) end++;
      for (let x = c; x <= end + 1; x++)
        sheet.getCell(HEADER_ROW, x).border = box;
      if (end > i) sheet.mergeCells(HEADER_ROW, c, HEADER_ROW, end + 1);
      styleHeader(sheet.getCell(HEADER_ROW, c), col.group, 13);
    });
    sheet.getRow(HEADER_ROW).height = twoRowHeader ? 24 : 36;
    if (twoRowHeader) sheet.getRow(HEADER_LAST).height = 34;

    const moneyFmt = new Map(
      columns
        .filter((c) => c.money)
        .map((c) => [
          c.key,
          sheetData.defaulterNumbers
            ? '0'
            : sheetData.rows.some(
                  (r) =>
                    typeof r[c.key] === 'number' && !Number.isInteger(r[c.key]),
                )
              ? MONEY_FMT_DECIMAL
              : MONEY_FMT,
        ]),
    );
    let rowIdx = HEADER_LAST + 1;
    const writeRow = (data: Record<string, string | number>, i: number) => {
      const row = sheet.getRow(rowIdx++);
      columns.forEach((col, c) => {
        const cell = row.getCell(c + 1);
        const value = col.key === '__sno' ? i + 1 : data[col.key];
        cell.value = value === undefined || value === null ? '' : value;
        if (col.money && typeof value === 'number')
          cell.numFmt = moneyFmt.get(col.key)!;
        cell.border = box;
        cell.font = col.money
          ? { name: SERIF, bold: true, size: col.group ? 11 : 12 }
          : { name: SERIF, size: 11 };
        // Text wraps (and the row grows) rather than being cut off at the column edge (TAFSD-425).
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: typeof value === 'string',
        };
      });
      row.height = 22;
    };

    // TOTAL (or a group's SUBTOTAL) under every summed column, labelled in the
    // columns before the first.
    const totalIdx = columns
      .map((col, i) => (col.total ? i + 1 : 0))
      .filter(Boolean);
    const writeTotal = (
      rows: Array<Record<string, string | number>>,
      text: string,
    ) => {
      if (!totalIdx.length || !rows.length) return;
      const totalRow = sheet.getRow(rowIdx);
      const first = totalIdx[0];
      if (first > 1) {
        const labelFrom = Math.max(1, first - 3);
        if (first - 1 > labelFrom)
          sheet.mergeCells(rowIdx, labelFrom, rowIdx, first - 1);
        const label = totalRow.getCell(labelFrom);
        label.value = text;
        label.font = { name: SERIF, bold: true, size: 12 };
        label.alignment = { horizontal: 'center', vertical: 'middle' };
        for (let c = labelFrom; c < first; c++)
          totalRow.getCell(c).border = box;
      }
      for (const idx of totalIdx) {
        const col = columns[idx - 1];
        const cell = totalRow.getCell(idx);
        const sum = rows.reduce(
          (acc, r) =>
            acc + (typeof r[col.key] === 'number' ? (r[col.key] as number) : 0),
          0,
        );
        cell.value = Math.round(sum * 100) / 100;
        cell.numFmt = col.money
          ? sheetData.defaulterNumbers
            ? '0.00'
            : moneyFmt.get(col.key)!
          : '0';
        cell.font = { name: SERIF, bold: true, size: 12 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = box;
      }
      totalRow.height = 22;
      rowIdx++;
    };

    if (!sheetData.groups) {
      sheetData.rows.forEach(writeRow);
    } else {
      // TAFSD-337/341: heading, the group's rows (S# restarts), SUBTOTAL, then
      // an empty row before the next group — as on the defaulters sheet.
      const [one, many] = sheetData.rowNoun ?? ['ROW', 'ROWS'];
      for (const group of sheetData.groups) {
        if (lastCol > 1) sheet.mergeCells(rowIdx, 1, rowIdx, lastCol);
        const heading = sheet.getCell(rowIdx, 1);
        heading.value = `${group.label} · ${group.rows.length} ${group.rows.length === 1 ? one : many}`;
        heading.font = { name: SERIF, bold: true, size: 12 };
        heading.alignment = {
          horizontal: 'left',
          vertical: 'middle',
          indent: 1,
        };
        heading.border = box;
        sheet.getRow(rowIdx).height = 22;
        rowIdx++;
        group.rows.forEach(writeRow);
        writeTotal(group.rows, 'SUBTOTAL');
        rowIdx++;
      }
    }
    writeTotal(sheetData.rows, 'TOTAL');

    // TAFSD-425: columns and rows grow to fit what's in them, so nothing is cut off.
    fitSheetToText(sheet, HEADER_ROW, HEADER_LAST);
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: HEADER_LAST }];
    sheet.pageSetup = {
      paperSize: 9, // A4
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      printTitlesRow: `${HEADER_ROW}:${HEADER_LAST}`,
      margins: {
        left: 0.3,
        right: 0.3,
        top: 0.4,
        bottom: 0.4,
        header: 0.2,
        footer: 0.2,
      },
    };
  }
}

/** "DAY :MONDAY" / "DATE : OCTOBER 12, 2026", as on the school's sheets. */
export function dayDateLines(isoDate: string): {
  dayLine: string;
  dateLine: string;
} {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return {
    dayLine: `DAY :${date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toUpperCase()}`,
    dateLine: `DATE : ${date
      .toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
      .toUpperCase()}`,
  };
}

/** "FROM 1 AUGUST 2026 TO 31 OCTOBER 2026" (or "ON …" for a single day). */
export function periodLine(fromDate: string, toDate: string): string {
  const fmt = (v: string) => {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d))
      .toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
      .toUpperCase();
  };
  return fromDate === toDate
    ? `ON ${fmt(fromDate)}`
    : `FROM ${fmt(fromDate)} TO ${fmt(toDate)}`;
}

/** Excel tab names: ≤31 chars, no []:/?\*, unique within the workbook. */
function uniqueTab(name: string, used: Set<string>): string {
  const base = (name.replace(/[[\]:/?\\*]/g, ' ').trim() || 'Sheet').slice(
    0,
    31,
  );
  let tab = base;
  for (let n = 2; used.has(tab.toLowerCase()); n++)
    tab = `${base.slice(0, 28)} ${n}`;
  used.add(tab.toLowerCase());
  return tab;
}
