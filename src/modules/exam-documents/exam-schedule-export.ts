import * as fs from 'fs';
import * as ExcelJS from 'exceljs';
import { FontSpec, LAYOUTS, LayoutSpec, ScheduleLayout, SCHEDULE_IMAGES } from './exam-schedule-layouts';

/**
 * TAFSD-524: an exam schedule as an Excel sheet laid out exactly like the
 * school's own, in one of four layouts (exam-schedule-layouts.ts):
 *
 *   [crest]                                              [logo]
 *   DAY : <weekday>                                   REF . # : <ref>
 *   DATE : <month dd, yyyy>
 *               <SCHOOL>
 *               SCHEDULE OF <ASSESSMENT>
 *               <segment line>
 *               SESSION : 2026 - 2027
 *               <CAMPUS>                     (Secondary only)
 *   | S # | DAY | DATE | ASSESSMENT TIMINGS | <class> | ...   (columns per layout)
 *   NOTE:  ● ...
 *   Regards,  [signature]
 *   Mrs. Sayeeda Asad, / Academic Directress, / <school>.
 *               <footer lines>
 *
 * Pure: the service passes the schedule in, the workbook comes out.
 */

export interface ScheduleSheetPaper {
    class_id: number;
    /** 'YYYY-MM-DD' */
    date: string;
    time: string;
    subject: string;
}

export interface ScheduleSheetInput {
    layout: ScheduleLayout;
    title: string;
    segmentLine: string | null;
    /** "2026-2027" */
    academicYear: string;
    /** "CAMPUS - II" */
    campusLabel: string;
    campusAddress: string;
    referenceNo: string | null;
    /** The letter's date, 'YYYY-MM-DD' (the day it is exported, in Karachi). */
    letterDate: string;
    classes: { id: number; description: string }[];
    papers: ScheduleSheetPaper[];
    notes: string[];
    /** Leave the images out (tests). */
    withoutImages?: boolean;
}

/** One printed row of the grid. */
export interface ScheduleSheetRow {
    date: string;
    /** The row's time, or the first class's when every class has its own. */
    time: string;
    cells: Record<number, { subject: string; time: string }>;
}

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/** Signed at the foot of every schedule the school sends. */
const SIGNATORY = ['Mrs. Sayeeda Asad,', 'Academic Directress,'];

const parts = (isoDate: string) => isoDate.slice(0, 10).split('-').map(Number) as [number, number, number];

/** "FRIDAY" */
export function weekdayOf(isoDate: string): string {
    const [y, m, d] = parts(isoDate);
    return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** "11 - 12 - 2026", as the school writes paper dates. */
export function paperDate(isoDate: string, sep = ' - '): string {
    const [y, m, d] = parts(isoDate);
    return [String(d).padStart(2, '0'), String(m).padStart(2, '0'), String(y)].join(sep);
}

/** "NOVEMBER 16, 2026" */
export function letterDateLabel(isoDate: string): string {
    const [y, m, d] = parts(isoDate);
    return `${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`;
}

/** "FIRST SEMESTER ASSESSMENTS" → "SCHEDULE OF FIRST SEMESTER ASSESSMENTS"; a title that already names the schedule is kept. */
export function scheduleHeading(title: string): string {
    const t = title.trim().toUpperCase();
    return /\bSCHEDULE\b/.test(t) ? t : `SCHEDULE OF ${t}`;
}

/** The line under the heading: the schedule's own, or "CLASSES IX & X" from its classes. */
export function segmentHeading(segmentLine: string | null, classNames: string[]): string {
    if (segmentLine?.trim()) return segmentLine.trim().toUpperCase();
    if (!classNames.length) return '';
    const names = classNames.map((c) => c.toUpperCase());
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
    return `${names.length === 1 ? 'CLASS' : 'CLASSES'} ${list}`;
}

/** "2026-2027" → "SESSION : 2026 - 2027" (in the layout's own form). */
export function sessionHeading(academicYear: string, layout: ScheduleLayout = 'SECONDARY'): string {
    const [a, b = ''] = academicYear.trim().split(/\s*-\s*/);
    return LAYOUTS[layout].sessionText([a, b]);
}

/**
 * Papers into printed rows. Normally a row is one date and time; on a layout
 * with a timing column per class (O Levels) a row is one date and each class
 * keeps its own time. Two papers of a class in one row are joined with " / ".
 */
export function scheduleRows(papers: ScheduleSheetPaper[], timingPerClass: boolean): ScheduleSheetRow[] {
    const rows = new Map<string, ScheduleSheetRow>();
    for (const p of papers) {
        const date = p.date.slice(0, 10);
        const time = p.time.trim();
        const key = timingPerClass ? date : `${date}|${time}`;
        let row = rows.get(key);
        if (!row) {
            row = { date, time, cells: {} };
            rows.set(key, row);
        }
        const prev = row.cells[p.class_id];
        row.cells[p.class_id] = prev
            ? { subject: `${prev.subject} / ${p.subject.trim()}`, time: prev.time === time ? time : `${prev.time} / ${time}` }
            : { subject: p.subject.trim(), time };
    }
    return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

/** Rough row height for wrapped text across `widthChars` characters of column. */
function wrappedHeight(text: string, widthChars: number, lineHeight: number, minHeight: number): number {
    const lines = Math.max(1, Math.ceil(text.length / Math.max(8, widthChars)));
    return Math.max(minHeight, lines * lineHeight);
}

const font = (f: FontSpec): Partial<ExcelJS.Font> => ({
    name: f.name,
    size: f.size,
    bold: f.bold ?? false,
    italic: f.italic ?? false,
    underline: f.underline ?? false,
});

/** Excel's own conversion from a column width in characters to pixels (Calibri 11, 7 px per character). */
const colPx = (width: number) => Math.trunc(((256 * width + Math.trunc(128 / 7)) / 256) * 7);

const BLACK = { argb: 'FF000000' };
const GREY: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0C0C0' } };

interface Column {
    kind: 'serial' | 'day' | 'date' | 'time' | 'class' | 'classTime';
    width: number;
    classId?: number;
    label: string;
}

function columnsFor(spec: LayoutSpec, classes: { id: number; description: string }[]): Column[] {
    const w = spec.widths;
    const cols: Column[] = [];
    if (spec.serial) cols.push({ kind: 'serial', width: w.serial, label: spec.key === 'O_LEVEL' ? 'S. #' : spec.key === 'JUNIOR' ? 'S. #' : 'S #' });
    cols.push({ kind: 'day', width: w.day, label: 'DAY' });
    cols.push({ kind: 'date', width: w.date, label: 'DATE' });
    if (!spec.timingPerClass) cols.push({ kind: 'time', width: w.time, label: 'ASSESSMENT TIMINGS' });
    const list = classes.length ? classes : [{ id: 0, description: '' }];
    for (const c of list) {
        cols.push({ kind: 'class', width: w.class(list.length), classId: c.id, label: spec.classLabel(c.description) });
        if (spec.timingPerClass) cols.push({ kind: 'classTime', width: w.time, classId: c.id, label: 'ASSESSMENT TIMINGS' });
    }
    return cols;
}

export async function buildScheduleWorkbook(input: ScheduleSheetInput): Promise<Buffer> {
    const spec = LAYOUTS[input.layout];
    const classes = [...input.classes].sort((a, b) => a.id - b.id);
    const cols = columnsFor(spec, classes);
    const nCols = cols.length;
    const firstClassCol = cols.findIndex((c) => c.kind === 'class' || (spec.levelsBand && c.kind === 'time')) + 1;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TAFS';
    wb.created = new Date();
    const ws = wb.addWorksheet('Schedule', {
        pageSetup: {
            paperSize: 9, // A4
            orientation: spec.landscape(classes.length) ? 'landscape' : 'portrait',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            horizontalCentered: true,
            margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
        },
        views: [{ showGridLines: false }],
    });
    ws.columns = cols.map((c) => ({ width: c.width }));
    const totalChars = cols.reduce((s, c) => s + c.width, 0);
    const totalPx = cols.reduce((s, c) => s + colPx(c.width), 0);
    /** Pixel offset → ExcelJS's fractional column anchor. */
    const colAt = (px: number) => {
        let left = 0;
        for (let i = 0; i < cols.length; i++) {
            const w = colPx(cols[i].width);
            if (px < left + w) return i + (px - left) / w;
            left += w;
        }
        return cols.length;
    };

    const centre: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle', wrapText: true };
    let r = 1;
    const fullRow = (text: string, f: FontSpec, height: number, align: Partial<ExcelJS.Alignment> = centre) => {
        ws.mergeCells(r, 1, r, nCols);
        const c = ws.getCell(r, 1);
        c.value = text;
        c.font = font(f);
        c.alignment = align;
        ws.getRow(r).height = height;
        r++;
    };
    const image = (file: string, col: number, row: number, size: [number, number]) => {
        if (input.withoutImages || !fs.existsSync(file)) return;
        const id = wb.addImage({ buffer: fs.readFileSync(file) as any, extension: 'png' });
        ws.addImage(id, { tl: { col, row } as any, ext: { width: size[0], height: size[1] }, editAs: 'oneCell' });
    };

    // Logos: the crest top left, the school's mark top right.
    ws.getRow(r).height = Math.round(Math.max(spec.leftLogoSize[1], spec.rightLogoSize[1]) * 0.75) + 4;
    image(spec.leftLogo, 0.05, 0.05, spec.leftLogoSize);
    image(spec.rightLogo, colAt(Math.max(0, totalPx - spec.rightLogoSize[0] - 4)), 0.1, spec.rightLogoSize);
    r++;

    // Letter heading: day and date on the left, reference on the right.
    const splitAt = Math.min(nCols, Math.max(2, Math.ceil(nCols / 2)));
    ws.mergeCells(r, 1, r, splitAt - 1);
    ws.getCell(r, 1).value = `DAY   :  ${weekdayOf(input.letterDate)}`;
    ws.getCell(r, 1).font = font(spec.letterFont);
    if (input.referenceNo?.trim()) {
        ws.mergeCells(r, splitAt, r, nCols);
        const ref = ws.getCell(r, splitAt);
        ref.value = `REF . # : ${input.referenceNo.trim()}`;
        ref.font = font(spec.refFont);
        ref.alignment = { horizontal: 'right', vertical: 'middle' };
    }
    ws.getRow(r).height = spec.letterFont.size + 5;
    r++;
    ws.mergeCells(r, 1, r, splitAt - 1);
    ws.getCell(r, 1).value = `DATE :  ${letterDateLabel(input.letterDate)}`;
    ws.getCell(r, 1).font = font(spec.letterFont);
    ws.getRow(r).height = spec.letterFont.size + 5;
    r++;

    fullRow(spec.school, spec.schoolFont, spec.schoolFont.size + 6);
    fullRow(scheduleHeading(input.title), spec.titleFont, spec.titleFont.size + 5);
    const segment = spec.deriveSegment
        ? segmentHeading(input.segmentLine, classes.map((c) => c.description))
        : (input.segmentLine?.trim().toUpperCase() ?? '');
    if (segment) fullRow(segment, spec.lineFont, spec.lineFont.size + 4);
    fullRow(sessionHeading(input.academicYear, spec.key), spec.sessionFont, spec.sessionFont.size + 4);
    if (spec.campusHeading) fullRow(input.campusLabel, spec.lineFont, spec.lineFont.size + 4);
    if (!spec.campusHeading || spec.levelsBand) ws.getRow(r++).height = 6;

    // ── The grid ──────────────────────────────────────────────────────────
    const gridTop = r;
    const cellFont = font(spec.headerFont);
    const head = (row: number, col: number, text: string, grey: boolean) => {
        const c = ws.getCell(row, col);
        c.value = text;
        c.font = cellFont;
        c.alignment = centre;
        if (grey) c.fill = GREY;
    };
    let headerRows = 1;
    if (spec.levelsBand && spec.key === 'O_LEVEL') {
        // "LEVELS" over the level and timing columns, the rest of the heading below it.
        ws.mergeCells(r, firstClassCol, r, nCols);
        const band = ws.getCell(r, firstClassCol);
        band.value = 'LEVELS';
        band.font = { name: 'Arial Black', size: 12, bold: true };
        band.alignment = centre;
        ws.getRow(r).height = 18;
        for (let c = firstClassCol; c <= nCols; c++) {
            ws.getCell(r, c).border = {
                top: { style: 'medium', color: BLACK },
                left: c === firstClassCol ? { style: 'medium', color: BLACK } : undefined,
                right: c === nCols ? { style: 'medium', color: BLACK } : undefined,
            };
        }
        r++;
        cols.forEach((col, i) => head(r, i + 1, col.label, spec.greyHeader && (col.kind === 'class' || col.kind === 'classTime')));
        ws.getRow(r).height = spec.headerHeight;
        r++;
        headerRows = 1;
    } else if (spec.levelsBand) {
        // Junior: S. # / DAY / DATE beside a "LEVELS" band, then timings and levels under it.
        cols.forEach((col, i) => {
            if (i + 1 < firstClassCol) head(r, i + 1, col.label, spec.greyHeader);
        });
        ws.mergeCells(r, firstClassCol, r, nCols);
        head(r, firstClassCol, 'LEVELS', spec.greyHeader);
        ws.getRow(r).height = spec.headerHeight + 8;
        r++;
        cols.forEach((col, i) => head(r, i + 1, i + 1 < firstClassCol ? '' : col.label, spec.greyHeader));
        ws.getRow(r).height = spec.headerHeight;
        r++;
        headerRows = 2;
    } else {
        cols.forEach((col, i) => head(r, i + 1, col.label, spec.greyHeader));
        ws.getRow(r).height = spec.headerHeight;
        r++;
    }
    const firstBodyRow = r;
    const tableTop = spec.levelsBand && spec.key === 'O_LEVEL' ? gridTop + 1 : gridTop;

    const rows = scheduleRows(input.papers, spec.timingPerClass);
    rows.forEach((row, n) => {
        let tallest = 1;
        cols.forEach((col, i) => {
            const cell = row.cells[col.classId ?? -1];
            let v = '';
            if (col.kind === 'serial') v = String(n + 1);
            else if (col.kind === 'day') v = weekdayOf(row.date);
            else if (col.kind === 'date') v = paperDate(row.date, spec.dateSep);
            else if (col.kind === 'time') v = row.time;
            else if (col.kind === 'class') v = cell?.subject ? cell.subject.toUpperCase() : '-';
            else if (col.kind === 'classTime') v = cell?.subject ? cell.time : '-';
            const c = ws.getCell(r, i + 1);
            c.value = v;
            c.font = font(spec.bodyFont);
            c.alignment = centre;
            const charsPerLine = Math.max(6, Math.floor(col.width * (10 / spec.bodyFont.size)) - 1);
            tallest = Math.max(tallest, Math.ceil(v.length / charsPerLine));
        });
        ws.getRow(r).height = Math.max(spec.bodyHeight, tallest * (spec.bodyFont.size + 3) + 4);
        r++;
    });
    if (!rows.length) {
        ws.getRow(r).height = spec.bodyHeight;
        r++;
    }
    const lastGridRow = r - 1;

    // Medium outline and heading rule, thin lines inside, as the school draws it.
    for (let gr = tableTop; gr <= lastGridRow; gr++) {
        for (let gc = 1; gc <= nCols; gc++) {
            const m = (edge: boolean): Partial<ExcelJS.Border> => ({ style: edge ? 'medium' : 'thin', color: BLACK });
            ws.getCell(gr, gc).border = {
                top: m(gr === tableTop || gr === firstBodyRow),
                bottom: m(gr === lastGridRow || gr === firstBodyRow - 1),
                left: m(gc === 1),
                right: m(gc === nCols),
            };
        }
    }
    if (headerRows === 2) {
        // The Junior heading's first three columns span both heading rows.
        for (let i = 1; i < firstClassCol; i++) ws.mergeCells(gridTop, i, gridTop + 1, i);
    }

    // ── Notes ─────────────────────────────────────────────────────────────
    const noteChars = totalChars * (8 / spec.noteFont.size) * 1.15;
    if (input.notes.length) {
        const n = ws.getCell(r, 1);
        n.value = spec.noteHeading;
        n.font = font(spec.noteHeadingFont);
        ws.getRow(r).height = spec.noteHeadingFont.size + 5;
        r++;
        for (const note of input.notes) {
            const text = `${spec.bullet}${note.trim().toUpperCase()}`;
            fullRow(text, spec.noteFont, wrappedHeight(text, noteChars, spec.noteFont.size + 3.5, spec.noteFont.size + 4), {
                horizontal: 'left',
                vertical: 'middle',
                wrapText: true,
            });
        }
    }
    ws.getRow(r++).height = 8;

    // ── Signature ─────────────────────────────────────────────────────────
    const signatureRow = r;
    if (spec.regards) {
        ws.getCell(r, 1).value = 'Regards,';
        ws.getCell(r, 1).font = font(spec.signatoryFont);
        ws.getRow(r).height = spec.signatoryFont.size + 5;
        r++;
        ws.getRow(r++).height = 22;
    }
    for (const line of [...SIGNATORY, spec.signatureSchool]) {
        ws.mergeCells(r, 1, r, Math.min(nCols, 3));
        const c = ws.getCell(r, 1);
        c.value = line;
        c.font = font(spec.signatoryFont);
        ws.getRow(r).height = spec.signatoryFont.size + 5;
        r++;
    }
    // The signature, signed across the names as on the school's sheets.
    image(SCHEDULE_IMAGES.signature, 0.25, Math.max(0, signatureRow - 1) - 0.1, [96, 84]);
    ws.getRow(r++).height = 6;

    // ── Footer ────────────────────────────────────────────────────────────
    const footer = spec.footer({ campusLabel: input.campusLabel, segmentLine: input.segmentLine, address: input.campusAddress });
    for (const line of footer) fullRow(line, spec.footerFont, spec.footerFont.size + 5);

    ws.pageSetup.printArea = `A1:${ws.getColumn(nCols).letter}${r - 1}`;
    return Buffer.from(await wb.xlsx.writeBuffer());
}
