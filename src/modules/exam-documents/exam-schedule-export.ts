import * as ExcelJS from 'exceljs';

/**
 * TAFSD-524: an exam schedule as an Excel sheet laid out like the school's own
 * (SCHEDULE OF PRELIMINARY.xls, SCHEDULE OF FINAL MID TERM EXAMINATION.xls):
 *
 *   DAY : <weekday>                                   REF . # : <ref>
 *   DATE : <month d, yyyy>
 *               THE AMERICAN FOUNDATION SECONDARY SCHOOL
 *               SCHEDULE OF <ASSESSMENT>
 *               <segment line>
 *               SESSION : 2026 - 2027
 *               <CAMPUS>
 *   | DAY | DATE | ASSESSMENT TIMINGS | <class> | <class> | ...
 *   NOTE:  • ...
 *   Mrs. Sayeeda Asad, / Academic Directress, / <school>.
 *               <campus : segment> / <address> / <web>
 *
 * Pure: the service passes the schedule in, the workbook comes out.
 */

export interface ScheduleSheetRow {
    /** 'YYYY-MM-DD' */
    date: string;
    time: string;
    /** class id → subject ("" or "-" when the class has no paper). */
    cells: Record<number, string>;
}

export interface ScheduleSheetInput {
    secondary: boolean;
    title: string;
    segmentLine: string | null;
    /** "2026-2027" */
    academicYear: string;
    campusName: string;
    referenceNo: string | null;
    /** The letter's date, 'YYYY-MM-DD' (the day it is exported, in Karachi). */
    letterDate: string;
    classes: { id: number; description: string }[];
    rows: ScheduleSheetRow[];
    notes: string[];
    campusLine: string;
    addressLines: string[];
}

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/** Signed at the foot of every schedule the school sends. */
const SIGNATORY = ['Mrs. Sayeeda Asad,', 'Academic Directress,'];

const SCHOOL = {
    secondary: { header: 'THE AMERICAN FOUNDATION SECONDARY SCHOOL', signature: 'The American Foundation Secondary School.' },
    alevel: {
        header: 'THE AMERICAN FOUNDATION SCHOOL FOR A LEVEL STUDIES',
        signature: 'The American Foundation School for A Level Studies.',
    },
};

const parts = (isoDate: string) => isoDate.slice(0, 10).split('-').map(Number) as [number, number, number];

/** "FRIDAY" */
export function weekdayOf(isoDate: string): string {
    const [y, m, d] = parts(isoDate);
    return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** "11 - 12 - 2026", as the school writes paper dates. */
export function paperDate(isoDate: string): string {
    const [y, m, d] = parts(isoDate);
    return `${String(d).padStart(2, '0')} - ${String(m).padStart(2, '0')} - ${y}`;
}

/** "NOVEMBER 16, 2026" */
export function letterDateLabel(isoDate: string): string {
    const [y, m, d] = parts(isoDate);
    return `${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`;
}

/** "FIRST SEMESTER ASSESSMENTS" → "SCHEDULE OF FIRST SEMESTER ASSESSMENTS"; a title that already says so is kept. */
export function scheduleHeading(title: string): string {
    const t = title.trim().toUpperCase();
    return t.startsWith('SCHEDULE') ? t : `SCHEDULE OF ${t}`;
}

/** The line under the heading: the schedule's own, or "CLASSES IX & X" from its classes. */
export function segmentHeading(segmentLine: string | null, classNames: string[]): string {
    if (segmentLine?.trim()) return segmentLine.trim().toUpperCase();
    if (!classNames.length) return '';
    const names = classNames.map((c) => c.toUpperCase());
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
    return `${names.length === 1 ? 'CLASS' : 'CLASSES'} ${list}`;
}

/** "2026-2027" → "SESSION : 2026 - 2027" */
export function sessionHeading(academicYear: string): string {
    return `SESSION : ${academicYear.trim().replace(/\s*-\s*/, ' - ')}`;
}

/** Rough row height for wrapped text across `widthChars` characters of column. */
function wrappedHeight(text: string, widthChars: number, lineHeight: number, minHeight: number): number {
    const lines = Math.max(1, Math.ceil(text.length / Math.max(10, widthChars)));
    return Math.max(minHeight, lines * lineHeight);
}

export async function buildScheduleWorkbook(input: ScheduleSheetInput): Promise<Buffer> {
    const school = input.secondary ? SCHOOL.secondary : SCHOOL.alevel;
    const classes = [...input.classes].sort((a, b) => a.id - b.id);
    const nCols = 3 + Math.max(1, classes.length);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TAFS';
    wb.created = new Date();
    const ws = wb.addWorksheet('Schedule', {
        pageSetup: {
            paperSize: 9, // A4
            orientation: classes.length > 4 ? 'landscape' : 'portrait',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            horizontalCentered: true,
            margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
        },
        views: [{ showGridLines: false }],
    });

    // Column widths from the school's sheet: DAY 18, DATE 22 (here 17, the date is short text), TIMINGS 22, classes 30–38.
    const classWidth = classes.length <= 2 ? 36 : classes.length <= 4 ? 30 : 24;
    ws.columns = [
        { width: 16 },
        { width: 17 },
        { width: 22 },
        ...Array.from({ length: nCols - 3 }, () => ({ width: classWidth })),
    ];
    const totalWidth = 16 + 17 + 22 + (nCols - 3) * classWidth;

    const arial = (size: number, extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: 'Arial', size, bold: true, ...extra });
    const times = (size: number): Partial<ExcelJS.Font> => ({ name: 'Times New Roman', size, bold: true });
    const centre: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle', wrapText: true };

    let r = 1;
    const fullRow = (text: string, font: Partial<ExcelJS.Font>, height: number, align: Partial<ExcelJS.Alignment> = centre) => {
        ws.mergeCells(r, 1, r, nCols);
        const c = ws.getCell(r, 1);
        c.value = text;
        c.font = font;
        c.alignment = align;
        ws.getRow(r).height = height;
        r++;
    };

    // Letter heading: day and date on the left, reference on the right.
    ws.getCell(r, 1).value = `DAY   :  ${weekdayOf(input.letterDate)}`;
    ws.getCell(r, 1).font = arial(9);
    if (input.referenceNo?.trim()) {
        ws.mergeCells(r, 4, r, nCols);
        const ref = ws.getCell(r, 4);
        ref.value = `REF . # : ${input.referenceNo.trim()}`;
        ref.font = times(10);
        ref.alignment = { horizontal: 'right', vertical: 'middle' };
    }
    ws.getRow(r).height = 13;
    r++;
    ws.getCell(r, 1).value = `DATE :  ${letterDateLabel(input.letterDate)}`;
    ws.getCell(r, 1).font = arial(9);
    ws.getRow(r).height = 13;
    r++;

    fullRow(school.header, { name: 'TemplateCapsSSK', size: 20, bold: true }, 26);
    fullRow(scheduleHeading(input.title), times(15), 20);
    const segment = segmentHeading(input.segmentLine, classes.map((c) => c.description));
    if (segment) fullRow(segment, times(14), 18);
    fullRow(sessionHeading(input.academicYear), times(14), 18);
    fullRow(input.campusName.toUpperCase(), times(14), 18);
    r++;

    // The grid: medium outside border, thin inside, as the school draws it.
    const firstGridRow = r;
    const header = ['DAY', 'DATE', 'ASSESSMENT TIMINGS', ...(classes.length ? classes.map((c) => c.description.toUpperCase()) : [''])];
    header.forEach((h, i) => {
        const c = ws.getCell(r, i + 1);
        c.value = h;
        c.font = arial(10);
        c.alignment = centre;
    });
    ws.getRow(r).height = 21;
    r++;
    const rows = [...input.rows].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    for (const row of rows) {
        const subjects = classes.map((c) => {
            const v = (row.cells[c.id] ?? '').trim();
            return v ? v.toUpperCase() : '-';
        });
        const values = [weekdayOf(row.date), paperDate(row.date), row.time.trim(), ...(classes.length ? subjects : [''])];
        values.forEach((v, i) => {
            const c = ws.getCell(r, i + 1);
            c.value = v;
            c.font = arial(10);
            c.alignment = centre;
        });
        const longest = Math.max(0, ...subjects.map((s) => s.length));
        ws.getRow(r).height = wrappedHeight('x'.repeat(longest), classWidth - 2, 13, 18);
        r++;
    }
    const lastGridRow = r - 1;
    for (let gr = firstGridRow; gr <= lastGridRow; gr++) {
        for (let gc = 1; gc <= nCols; gc++) {
            const thick = (edge: boolean) => ({ style: edge ? ('medium' as const) : ('thin' as const) });
            ws.getCell(gr, gc).border = {
                top: thick(gr === firstGridRow || gr === firstGridRow + 1),
                bottom: thick(gr === lastGridRow || gr === firstGridRow),
                left: thick(gc === 1),
                right: thick(gc === nCols),
            };
        }
    }
    r++;

    if (input.notes.length) {
        const n = ws.getCell(r, 1);
        n.value = 'NOTE:';
        n.font = arial(11, { underline: true });
        ws.getRow(r).height = 15;
        r++;
        for (const note of input.notes) {
            const text = `•   ${note.trim().toUpperCase()}`;
            fullRow(text, arial(8), wrappedHeight(text, totalWidth * 1.15, 11, 12), { horizontal: 'left', vertical: 'top', wrapText: true });
        }
        r++;
    }

    for (const line of [...SIGNATORY, school.signature]) {
        const c = ws.getCell(r, 1);
        c.value = line;
        c.font = arial(9);
        ws.getRow(r).height = 13;
        r++;
    }
    r++;
    for (const line of [input.campusLine, ...input.addressLines].filter(Boolean)) {
        fullRow(line, arial(8), 12);
    }

    ws.pageSetup.printArea = `A1:${ws.getColumn(nCols).letter}${r - 1}`;
    return Buffer.from(await wb.xlsx.writeBuffer());
}
