import React from 'react';
import * as ExcelJS from 'exceljs';
import {
  Document,
  Font,
  Page,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import {
  type StandardFont,
  textWidthPt,
  wrappedLineCount,
} from './standard-font-widths';

/**
 * TAFSD-417: a landscape PDF print of an ExcelJS workbook — the defaulters
 * sheet exactly as the Excel export builds it, so the two can't disagree.
 * Each worksheet (one per campus) is its own run of pages: the title block
 * (the merged banner rows at the top) and the column header rows
 * (pageSetup.printTitlesRow) repeat on every page, with "PAGE X OF Y" under
 * it. Columns are shrunk to the page width, never past MIN_SCALE: a sheet too
 * wide for A4 at that size has to go on A3.
 */

export type SheetPaper = 'A4' | 'A3';

/** Landscape page sizes in points. */
const PAGE: Record<SheetPaper, { width: number; height: number }> = {
  A4: { width: 841.89, height: 595.28 },
  A3: { width: 1190.55, height: 841.89 },
};
const MARGIN = 20;
const FOOTER = 16;
/** Smallest shrink allowed: an 11pt body cell prints at ~6.8pt. */
export const MIN_SCALE = 0.62;
/** Points per Excel column-width character (≈7px at 96dpi plus cell padding). */
const PT_PER_CHAR = 5.6;
const DEFAULT_ROW_HEIGHT = 15;
const DEFAULT_COL_WIDTH = 9;

// Excel never hyphenates: "EARLIER" in a narrow header stays one word.
Font.registerHyphenationCallback((word) => [word]);

type Region = { top: number; left: number; bottom: number; right: number };

const colIndex = (letters: string) =>
  [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
function parseRange(ref: string): Region {
  const [a, b = a] = ref.split(':');
  const parse = (s: string) => {
    const m = /^([A-Z]+)(\d+)$/.exec(s)!;
    return { col: colIndex(m[1]), row: Number(m[2]) };
  };
  const from = parse(a);
  const to = parse(b);
  return { top: from.row, left: from.col, bottom: to.row, right: to.col };
}

const columnCount = (ws: ExcelJS.Worksheet) =>
  Math.max(ws.actualColumnCount, ws.columnCount, ws.columns?.length ?? 0, 1);
const colWidthPt = (ws: ExcelJS.Worksheet, c: number) =>
  (ws.getColumn(c).width ?? DEFAULT_COL_WIDTH) * PT_PER_CHAR;
const rowHeightPt = (ws: ExcelJS.Worksheet, r: number) =>
  ws.getRow(r).height ?? DEFAULT_ROW_HEIGHT;

/** The sheet's natural width in points, before any shrinking. */
export function sheetWidthPt(ws: ExcelJS.Worksheet): number {
  let w = 0;
  for (let c = 1; c <= columnCount(ws); c++) w += colWidthPt(ws, c);
  return w;
}

const usableWidth = (paper: SheetPaper) => PAGE[paper].width - 2 * MARGIN;

/** Whether every sheet of the workbook fits this paper without shrinking past MIN_SCALE. */
export function workbookFitsPaper(
  workbook: ExcelJS.Workbook,
  paper: SheetPaper,
): boolean {
  return workbook.worksheets.every(
    (ws) => sheetWidthPt(ws) * MIN_SCALE <= usableWidth(paper),
  );
}

/** A cell's text as Excel shows it, for the number formats the school sheets use. */
export function displayText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v == null) return '';
  if (typeof v === 'number') {
    const fmt = cell.numFmt ?? '';
    const prefix = /^"([^"]*)"/.exec(fmt)?.[1] ?? '';
    const decimals = /0\.(0+)/.exec(fmt)?.[1].length ?? (fmt ? 0 : -1);
    if (decimals < 0) return prefix + String(v);
    // "#,##0" / "#,##0.00": thousands separators, as Excel shows them.
    if (/#,##/.test(fmt)) {
      return (
        prefix +
        v.toLocaleString('en-US', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })
      );
    }
    return prefix + v.toFixed(decimals);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as {
      richText?: Array<{ text: string }>;
      text?: string;
      result?: string | number | boolean;
    };
    if (o.richText) return o.richText.map((t) => t.text).join('');
    if (o.text != null) return String(o.text);
    if (o.result != null) return String(o.result);
    return '';
  }
  return String(v as string | boolean);
}

const LINE_HEIGHT = 1.15;
const V_PAD = 1.5;
const BORDER = 0.6;
const cellPadding = (cell: ExcelJS.Cell, scale: number) =>
  2 + (cell.alignment?.indent ?? 0) * 4 * scale;

const fontFamily = (font: Partial<ExcelJS.Font> | undefined): StandardFont => {
  const serif = /times|serif/i.test(font?.name ?? '');
  if (serif) return font?.bold ? 'Times-Bold' : 'Times-Roman';
  return font?.bold ? 'Helvetica-Bold' : 'Helvetica';
};

type Box = { left: number; top: number; width: number; height: number };
type DrawCell = Box & { text: string; cell: ExcelJS.Cell; fontSize: number };
type PageModel = {
  cells: DrawCell[];
  pageNumber: number;
  totalPages: number;
  sheetName: string;
  scale: number;
};

/**
 * Lays one worksheet out into pages: absolute boxes for every cell in
 * points, the repeated title and header rows on each page after the first.
 */
function layoutSheet(ws: ExcelJS.Worksheet, paper: SheetPaper): PageModel[] {
  const cols = columnCount(ws);
  const scale = Math.min(1, usableWidth(paper) / sheetWidthPt(ws));
  const x: number[] = [MARGIN];
  for (let c = 1; c <= cols; c++) x[c] = x[c - 1] + colWidthPt(ws, c) * scale;

  const merges: Region[] = (
    (ws.model as { merges?: string[] }).merges ?? []
  ).map(parseRange);
  const masterOf = new Map<string, Region>();
  const covered = new Set<string>();
  for (const m of merges) {
    masterOf.set(`${m.top}:${m.left}`, m);
    for (let r = m.top; r <= m.bottom; r++)
      for (let c = m.left; c <= m.right; c++)
        if (r !== m.top || c !== m.left) covered.add(`${r}:${c}`);
  }

  const lastRow = ws.actualRowCount ? ws.rowCount : 0;
  const titles = /^(\d+):(\d+)$/.exec(ws.pageSetup?.printTitlesRow ?? '');
  const headerFrom = titles ? Number(titles[1]) : 0;
  const headerTo = titles ? Number(titles[2]) : 0;
  // The title block: the banner rows above the first blank row.
  let titleTo = 0;
  while (titleTo < lastRow && ws.getRow(titleTo + 1).actualCellCount > 0)
    titleTo++;
  if (headerFrom && titleTo >= headerFrom) titleTo = 0;
  const repeated = [
    ...Array.from({ length: titleTo }, (_, i) => i + 1),
    ...(headerFrom
      ? Array.from(
          { length: headerTo - headerFrom + 1 },
          (_, i) => headerFrom + i,
        )
      : []),
  ];

  const isEmpty = (r: number, c: number) =>
    !covered.has(`${r}:${c}`) &&
    !masterOf.has(`${r}:${c}`) &&
    displayText(ws.getCell(r, c)) === '';

  type Span = {
    c: number;
    right: number;
    bottom: number;
    text: string;
    cell: ExcelJS.Cell;
    fontSize: number;
  };
  /** The cells a row draws: each with the last column and row it covers. */
  const spansOf = (r: number): Span[] => {
    const out: Span[] = [];
    for (let c = 1; c <= cols; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const cell = ws.getCell(r, c);
      const merge = masterOf.get(`${r}:${c}`);
      let right = merge?.right ?? c;
      const text = displayText(cell);
      // Excel lets unwrapped text run on into empty cells to its right.
      if (
        !merge &&
        text &&
        !cell.alignment?.wrapText &&
        (cell.alignment?.horizontal ?? 'left') === 'left'
      ) {
        while (right < cols && isEmpty(r, right + 1)) right++;
      }
      if (!text && !cell.border) continue;
      // A word wider than its box ("EARLIER" over a narrow month column)
      // can't wrap, so the font shrinks until it fits, as Excel's shrink to fit.
      const size = (cell.font?.size ?? 11) * scale;
      const inner =
        x[right] - x[c - 1] - 2 * cellPadding(cell, scale) - 2 * BORDER;
      const font = fontFamily(cell.font);
      const widest = Math.max(
        0,
        ...text.split(/\s+/).map((w) => textWidthPt(w, font, size)),
      );
      const fontSize =
        widest > inner && inner > 0 ? (size * inner) / widest : size;
      out.push({ c, right, bottom: merge?.bottom ?? r, text, cell, fontSize });
    }
    return out;
  };
  const spans = new Map<number, Span[]>();
  for (let r = 1; r <= lastRow; r++) spans.set(r, spansOf(r));

  // Row heights: Excel's, scaled, but grown wherever the text needs more
  // lines than Excel was told (Excel never grows a row for wrapped text it
  // didn't write itself, and react-pdf would otherwise clip it).
  const height: number[] = [];
  for (let r = 1; r <= lastRow; r++) height[r] = rowHeightPt(ws, r) * scale;
  for (let r = 1; r <= lastRow; r++) {
    for (const s of spans.get(r)!) {
      if (!s.text) continue;
      const inner =
        x[s.right] - x[s.c - 1] - 2 * cellPadding(s.cell, scale) - 2 * BORDER;
      const lines = wrappedLineCount(
        s.text,
        fontFamily(s.cell.font),
        s.fontSize,
        inner,
      );
      // The text box sits inside the padding and the borders; a point spare
      // so react-pdf never drops the last line.
      const need = lines * s.fontSize * LINE_HEIGHT + 2 * (V_PAD + BORDER) + 1;
      let have = 0;
      for (let rr = r; rr <= s.bottom; rr++) have += height[rr];
      if (need > have) height[s.bottom] += need - have;
    }
  }

  const bottom = PAGE[paper].height - MARGIN - FOOTER;
  const pages: DrawCell[][] = [];
  let current: DrawCell[] = [];
  let y = MARGIN;
  const place = (r: number) => {
    for (const s of spans.get(r)!) {
      let h = 0;
      for (let rr = r; rr <= s.bottom; rr++) h += height[rr];
      current.push({
        left: x[s.c - 1],
        top: y,
        width: x[s.right] - x[s.c - 1],
        height: h,
        text: s.text,
        cell: s.cell,
        fontSize: s.fontSize,
      });
    }
    y += height[r];
  };
  const startPage = () => {
    pages.push(current);
    current = [];
    y = MARGIN;
    for (const r of repeated) place(r);
  };
  const repeatedHeight = repeated.reduce((sum, r) => sum + height[r], 0);
  for (let r = 1; r <= lastRow; r++) {
    // Rows a merge spans together (the two-row header) move as one block.
    let blockEnd = r;
    for (let c = 1; c <= cols; c++)
      blockEnd = Math.max(blockEnd, masterOf.get(`${r}:${c}`)?.bottom ?? r);
    let blockH = 0;
    for (let rr = r; rr <= blockEnd; rr++) blockH += height[rr];
    const pageHasBody = y > MARGIN + repeatedHeight + 0.01;
    if (y + blockH > bottom && pageHasBody) startPage();
    for (let rr = r; rr <= blockEnd; rr++) place(rr);
    r = blockEnd;
  }
  pages.push(current);
  return pages.map((cells, i) => ({
    cells,
    pageNumber: i + 1,
    totalPages: pages.length,
    sheetName: ws.name,
    scale,
  }));
}

function CellBox({ d, scale }: { d: DrawCell; scale: number }) {
  const { cell } = d;
  const b = cell.border ?? {};
  const line = (side?: Partial<ExcelJS.Border>) => (side?.style ? BORDER : 0);
  const horizontal = cell.alignment?.horizontal;
  const textAlign =
    horizontal === 'center' || horizontal === 'centerContinuous'
      ? 'center'
      : horizontal === 'right'
        ? 'right'
        : 'left';
  const size = d.fontSize;
  const vertical = cell.alignment?.vertical;
  return (
    <View
      style={{
        position: 'absolute',
        // Grown by half a border all round, so a cell's border lands exactly
        // on its neighbour's: every rule prints one border thick.
        left: d.left - BORDER / 2,
        top: d.top - BORDER / 2,
        width: d.width + BORDER,
        height: d.height + BORDER,
        borderTopWidth: line(b.top),
        borderBottomWidth: line(b.bottom),
        borderLeftWidth: line(b.left),
        borderRightWidth: line(b.right),
        borderColor: '#000',
        justifyContent:
          vertical === 'top'
            ? 'flex-start'
            : vertical === 'bottom'
              ? 'flex-end'
              : 'center',
        paddingHorizontal: cellPadding(cell, scale),
        paddingVertical: V_PAD,
        overflow: 'hidden',
      }}
    >
      {d.text ? (
        <Text
          style={{
            fontFamily: fontFamily(cell.font),
            fontSize: size,
            textAlign,
            lineHeight: LINE_HEIGHT,
          }}
        >
          {d.text}
        </Text>
      ) : null}
    </View>
  );
}

function SheetDocument({
  pages,
  paper,
  title,
}: {
  pages: PageModel[];
  paper: SheetPaper;
  title: string;
}) {
  return (
    <Document title={title} creator="The American Foundation School">
      {pages.map((p, i) => (
        <Page
          key={i}
          size={paper}
          orientation="landscape"
          style={{ color: '#000' }}
        >
          {p.cells.map((d, j) => (
            <CellBox key={j} d={d} scale={p.scale} />
          ))}
          <View
            style={{
              position: 'absolute',
              left: MARGIN,
              right: MARGIN,
              bottom: MARGIN - 6,
              flexDirection: 'row',
              justifyContent: 'space-between',
              fontFamily: 'Times-Bold',
              fontSize: 8,
            }}
          >
            <Text>{p.sheetName.toUpperCase()}</Text>
            <Text>{`PAGE ${p.pageNumber} OF ${p.totalPages}`}</Text>
          </View>
        </Page>
      ))}
    </Document>
  );
}

/** Every worksheet of the workbook, in order, as one landscape PDF. */
export async function workbookToPdf(
  workbook: ExcelJS.Workbook,
  paper: SheetPaper,
  title: string,
): Promise<Buffer> {
  const pages = workbook.worksheets.flatMap((ws) => layoutSheet(ws, paper));
  return Buffer.from(
    await renderToBuffer(
      <SheetDocument pages={pages} paper={paper} title={title} />,
    ),
  );
}

export const __test = { layoutSheet };
