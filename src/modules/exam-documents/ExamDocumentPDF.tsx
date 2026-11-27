import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { Circle, Document, Font, G, Image, Line, Page, Rect, StyleSheet, Svg, Text, View } from '@react-pdf/renderer';
import type { ExamDocType } from './exam-document-rules';
import type { Notice, NoticeItem } from './exam-notices';
import { noticeItemText } from './exam-notices';
import { TIMES_DEFAULT_LH, timesLines } from './times-metrics';

/**
 * TAFSD-510: admit card (VI–X) and statement of entry (every other class).
 * TAFSD-528: both follow the A Level Sr I statement of entry the school signed off
 * (scripts/exam-docs-sample.cjs, StatementOfEntry): set in Times, school name and
 * document title in Stencil. A statement of entry always has a back page: the
 * segment's Notice to Candidates (exam-notices.ts) and then the schedule's results /
 * PTM line. An admit card is one page. Every page ends with "PAGE # 01 OF 02".
 *
 * TAFSD-555: which note goes where.
 *   Front of both documents, the box under the table: the schedule's front note
 *     (`frontNotes`, set in the editor), or the two standard lines when it is empty.
 *     Bullets on a statement of entry, numbered under NOTE: on an admit card.
 *   Back of a statement of entry: the fixed Notice to Candidates, then the results /
 *     PTM line from the schedule sheet's notes (`notes`).
 *   The rest of the schedule sheet's notes print only on the sheet and its Excel export.
 */

// Never hyphenate ("OB-TAINED").
Font.registerHyphenationCallback((word) => [word]);

/**
 * Stencil is a commercial font (Microsoft Office / Adobe), so it is not on npm; the
 * school's copy lives in fonts/. Without the file the headings fall back to Times Bold.
 */
const STENCIL_FILE = ['Stencil.ttf', 'Stencil.otf', 'STENCIL.TTF']
    .map((f) => path.join(process.cwd(), 'fonts', f))
    .find((f) => fs.existsSync(f));
if (STENCIL_FILE) Font.register({ family: 'Stencil', src: STENCIL_FILE });
export const HEADING_FONT = STENCIL_FILE ? 'Stencil' : 'Times-Bold';

const LOGOS = path.join(process.cwd(), 'logos');
export const EXAM_LOGO = {
    secondary: path.join(LOGOS, 'Logo The American Foundation Sec School (2).png'),
    alevel: path.join(LOGOS, 'A-Level Logo.png'),
    /** The American Foundation "Each One Teach One" mark with the US flag. */
    motto: path.join(LOGOS, 'Logo-Each-One-Teach-One.png'),
    /** From the TAFSAL leaving-certificate blank (item 64). */
    cambridge: path.join(LOGOS, 'Cambridge International Education.png'),
};

export interface ExamPaperLine {
    day: string;
    /** "DECEMBER 22, 2026" (statement of entry) */
    date: string;
    /** "FRIDAY, DECEMBER 11, 2026" (admit card) */
    dayDate: string;
    time: string;
    subject: string;
    code: string | null;
}

export interface ExamDocPage {
    docType: ExamDocType;
    serial: string;
    school: string;
    title: string;
    lines: string[];
    leftLogo: string;
    rightLogo: 'motto' | 'cambridge';
    className: string;
    sectionName: string | null;
    cc: string;
    gr: string;
    name: string;
    father: string;
    dob: string;
    gender: string | null;
    /** Admit card's GROUP box: SCIENCE for VI–VIII, the directory's discipline for IX–X. */
    group: string;
    photo: string | null;
    initials: string;
    papers: ExamPaperLine[];
    /** Statement of entry only: the schedule's results / PTM line, the last bullet under the notice. */
    notes: string[];
    /** TAFSD-555: the box under the table on the front. Empty: the two standard lines. */
    frontNotes: string[];
    /**
     * TAFSD-555: points taken off the room the front note may use, found by rendering the front
     * page (exam-front-fit.ts settleFrontFit) when the measured fit still spilled onto a second
     * sheet. 0 when the measurement held, which is nearly always.
     */
    frontSlack?: number;
    /** Cambridge centre number, printed before the candidate number (the C.C.) on a statement of entry. */
    centre: string;
    /** Statement of entry only: the Notice to Candidates on its back page. */
    notice: Notice | null;
    /** The schedule's title, heading its notes under the notice. */
    assessment: string;
    campusLine: string;
    /** The campus record's address, in capitals; null when the campus has none. */
    campusAddress: string | null;
    /** TAFSD-549: the campus's UAN number; null when it has none. */
    campusUan: string | null;
    /** Emails and website, as written. */
    webLine: string;
    issuedLong: string;
}

const F = { r: 'Times-Roman', b: 'Times-Bold', i: 'Times-Italic', bi: 'Times-BoldItalic' };
const INK = '#111111';
const MUTED = '#444444';
const RULE = '#111111';
const SHADE = '#f2f2f2';
const LABEL_W = 142;
/** Text width of the name boxes beside the photo (page less label, photo and padding). */
const NAME_BOX_W = 270;

const s = StyleSheet.create({
    page: { padding: 18, fontFamily: F.r, fontSize: 10, color: INK },
    frame: { flex: 1, borderWidth: 1.2, borderColor: RULE, paddingTop: 10, paddingHorizontal: 16, paddingBottom: 6 },
    /** The notice page: the same box as the front page, without the border (TAFSD-528). */
    backFrame: { flex: 1, paddingTop: 9, paddingHorizontal: 17, paddingBottom: 7 },
    logos: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    logoL: { width: 52, height: 50 },
    logoMotto: { width: 100, height: 29, marginTop: 4 },
    logoCambridge: { width: 118, height: 26.9, marginTop: 5 },
    school: { fontFamily: HEADING_FONT, fontSize: 18, textAlign: 'center', letterSpacing: 0.3, marginTop: 4 },
    docTitle: { fontFamily: HEADING_FONT, fontSize: 14, textAlign: 'center', marginTop: 4, letterSpacing: 2 },
    titleLine: { fontFamily: F.b, fontSize: 11.5, textAlign: 'center', marginTop: 1.5 },
    row: { flexDirection: 'row', alignItems: 'center' },
    label: { fontFamily: F.b, fontSize: 9.5, letterSpacing: 0.3 },
    box: { borderWidth: 0.9, borderColor: RULE, paddingVertical: 3.5, paddingHorizontal: 6, justifyContent: 'center' },
    boxText: { fontFamily: F.b, fontSize: 10.5 },
    photo: { width: 82, height: 98, borderWidth: 1, borderColor: RULE, alignItems: 'center', justifyContent: 'center', backgroundColor: SHADE },
    photoImg: { width: 80, height: 96, objectFit: 'cover' },
    photoInitials: { fontFamily: F.b, fontSize: 28, color: '#9a9a9a' },
    photoNote: { fontSize: 6.5, color: '#888888', marginTop: 3, letterSpacing: 0.5 },
    table: { borderWidth: 0.9, borderColor: RULE },
    thRow: { flexDirection: 'row', backgroundColor: SHADE, borderBottomWidth: 0.9, borderBottomColor: RULE },
    th: { fontFamily: F.b, fontSize: 8.5, textAlign: 'center', paddingVertical: 4, paddingHorizontal: 3, letterSpacing: 0.2 },
    tr: { flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: '#9a9a9a' },
    td: { fontSize: 10, paddingHorizontal: 5, textAlign: 'center' },
    vline: { borderLeftWidth: 0.5, borderLeftColor: '#9a9a9a' },
    footerBox: { borderWidth: 0.9, borderColor: RULE, paddingVertical: 4, alignItems: 'center' },
    footCampus: { fontFamily: F.b, fontSize: 9, letterSpacing: 0.4 },
    footText: { fontSize: 7.5, marginTop: 1.5, textAlign: 'center', color: MUTED },
    sysNote: { fontFamily: F.i, fontSize: 7.5, textAlign: 'center', marginTop: 3, color: MUTED },
    pageNo: { fontFamily: F.b, fontSize: 9, textAlign: 'center', marginTop: 3, letterSpacing: 0.3 },
});

const two = (n: number) => String(n).padStart(2, '0');

/** "PAGE # 01 OF 02" */
export function pageCountLabel(page: number, of: number): string {
    return `PAGE # ${two(page)} OF ${two(of)}`;
}

/** The two standard lines under the table on the front page, as on the Sr I statement of entry. */
export function standardFrontNotes(d: Pick<ExamDocPage, 'docType'>): string[] {
    const doc = d.docType === 'ADMIT_CARD' ? 'admit card' : 'statement of entry';
    return [
        'All entry details, including the spelling of your name and date of birth, must be checked for accuracy.',
        `Bring this ${doc} every day until the last day of the assessments.`,
    ].map((n) => n.toUpperCase());
}

function Header({ d }: { d: ExamDocPage }) {
    return (
        <View>
            <View style={s.logos}>
                <Image src={d.leftLogo} style={s.logoL} />
                <Image
                    src={d.rightLogo === 'cambridge' ? EXAM_LOGO.cambridge : EXAM_LOGO.motto}
                    style={d.rightLogo === 'cambridge' ? s.logoCambridge : s.logoMotto}
                />
            </View>
            <Text style={[s.school, d.school.length > 44 ? { fontSize: 15.5 } : {}]}>{d.school}</Text>
            <Text style={s.docTitle}>{d.title}</Text>
            {d.lines.map((l, i) => (
                <Text key={i} style={s.titleLine}>{l}</Text>
            ))}
            {/* TAFSD-528: no serial on the printed document (kept on record for reprints). */}
        </View>
    );
}

/** Values sit at the left of their box; an empty box shows a dash in its centre. */
function Field(p: { label: string; value: string; labelW?: number; boxW?: number; mt?: number; fitW?: number }) {
    const { label, value, labelW = LABEL_W, boxW, mt = 7, fitW } = p;
    const empty = !value.trim();
    const size = fitW && !empty ? fitOneLine(value, fitW) : undefined;
    return (
        <View style={[s.row, { marginTop: mt }]}>
            <Text style={[s.label, { width: labelW }]}>{`${label} :`}</Text>
            <View style={[s.box, boxW ? { width: boxW } : { flex: 1 }]}>
                <Text style={[s.boxText, { textAlign: empty ? 'center' : 'left' }, size ? { fontSize: size } : {}]}>{empty ? '-' : value}</Text>
            </View>
        </View>
    );
}

function Photo({ d }: { d: ExamDocPage }) {
    if (d.photo) {
        return (
            <View style={s.photo}>
                <Image src={d.photo} style={s.photoImg} />
            </View>
        );
    }
    return (
        <View style={s.photo}>
            <Text style={s.photoInitials}>{d.initials}</Text>
            <Text style={s.photoNote}>PHOTOGRAPH</Text>
        </View>
    );
}

const klassOf = (d: ExamDocPage) => (d.sectionName ? `${d.className} – ${d.sectionName}` : d.className);

function EntryFields({ d }: { d: ExamDocPage }) {
    return (
        <View style={[s.row, { marginTop: 10, alignItems: 'flex-end' }]}>
            <View style={{ flex: 1, paddingRight: 14 }}>
                <View style={s.row}>
                    <Field label="CENTRE / CANDIDATE #" value={`${d.centre} / ${d.cc}`} boxW={120} mt={0} />
                    <View style={{ flex: 1 }} />
                    <Field label="LEVEL" value={klassOf(d).toUpperCase()} labelW={44} boxW={88} mt={0} fitW={88} />
                </View>
                <Field label="CANDIDATE'S NAME" value={d.name} fitW={NAME_BOX_W} />
                <View style={s.row}>
                    <Field label="DATE OF BIRTH" value={d.dob} boxW={120} />
                    <View style={{ flex: 1 }} />
                    <Field label="GENDER" value={d.gender ?? ''} labelW={50} boxW={40} />
                </View>
                <Field label="PREVIOUS ENTRY DETAIL" value="" />
            </View>
            <Photo d={d} />
        </View>
    );
}

function AdmitFields({ d }: { d: ExamDocPage }) {
    return (
        <View style={[s.row, { marginTop: 10, alignItems: 'flex-end' }]}>
            <View style={{ flex: 1, paddingRight: 14 }}>
                <View style={s.row}>
                    <Field label="CLASS" value={klassOf(d).toUpperCase()} labelW={44} boxW={88} mt={0} />
                    <View style={{ flex: 1 }} />
                    <Field label="C.C. #" value={d.cc} labelW={42} boxW={66} mt={0} />
                    <View style={{ flex: 1 }} />
                    <Field label="G.R. #" value={d.gr} labelW={42} boxW={66} mt={0} />
                </View>
                <Field label="STUDENT'S NAME" value={d.name} fitW={NAME_BOX_W} />
                <Field label="FATHER'S NAME" value={d.father} fitW={NAME_BOX_W} />
                <View style={s.row}>
                    <Field label="DATE OF BIRTH" value={d.dob} boxW={120} />
                    <View style={{ flex: 1 }} />
                    <Field label="GENDER" value={d.gender ?? ''} labelW={50} boxW={40} />
                </View>
                <Field label="GROUP" value={d.group} boxW={150} fitW={150} />
            </View>
            <Photo d={d} />
        </View>
    );
}

/** Lines a subject takes in its column: columnChars is how many Times Bold capitals fit on one line. */
export function subjectLines(subject: string, columnChars: number): number {
    let lines = 1;
    let used = 0;
    for (const word of subject.trim().split(/\s+/)) {
        if (used && used + 1 + word.length > columnChars) {
            lines++;
            used = word.length;
        } else used += (used ? 1 : 0) + word.length;
    }
    return lines;
}

/** Capitals that fit on one line of the subject column (measured on the O-III and IX schedules). */
const SUBJECT_CHARS = { entry: 29, admit: 40 };

/** Height the front page leaves for the paper rows (ten one-line rows at the Sr I spacing). */
const ROWS_BUDGET = 204;
const LINE_H = 11.5;

/**
 * An admit card is one page: its rows and the schedule's notes share this height (it has
 * one heading line fewer than a statement of entry and no notice on a back page).
 */
// TAFSD-528: the signature boxes are gone, which gives back more than the GROUP row takes.
const ADMIT_BUDGET = 325;
const ADMIT_NOTE_SIZES = [8.5, 8, 7.5, 7, 6.5];

/** Height of the box carrying the two standard front-page lines (the TAFSD-528 calibration). */
const STANDARD_NOTES_H = 42;

/**
 * TAFSD-555: the front note's box, in points, from the page's own measurements:
 * A4 595.28 wide, less the page padding (18 a side), the frame's border (1.2) and padding (16),
 * then the box's border (0.9) and padding (8), then the bullet (12) or the number (16).
 */
export const FRONT_BOX = {
    entryTextW: 595.28 - 2 * 18 - 2 * 1.2 - 2 * 16 - 2 * 0.9 - 2 * 8 - 12,
    admitTextW: 595.28 - 2 * 18 - 2 * 1.2 - 2 * 16 - 2 * 0.9 - 2 * 8 - 16,
    /** Border and vertical padding of the box. */
    chrome: 2 * 0.9 + 2 * 5,
    /** The admit card's underlined NOTE: heading (9pt Times Bold) and the 3pt under it. */
    admitHeading: 9 * TIMES_DEFAULT_LH.b + 3,
} as const;

/**
 * TAFSD-555: the empty space left above the footer, beyond the paper rows' budget and the box
 * of standard lines. Found by rendering the school's December 2026 schedules with longer and
 * longer notes (scripts/exam-front-note-calibrate.ts): 118.5 to 156 points on a statement of
 * entry (Jr I has the least), 52 to 64 on an admit card. These are the low ends, so a measured
 * fit rarely spills; settleFrontFit renders the page and takes room back when one does.
 */
export const FRONT_SPARE = { entry: 118, admit: 52 };

const ENTRY_NOTE_SIZES = [9.5, 9, 8.5, 8, 7.5, 7, 6.5];

/** The size a front note prints at when nothing has to shrink (9.5pt bullets, 8.5pt numbered). */
export const FULL_NOTE_SIZE = { STATEMENT_OF_ENTRY: ENTRY_NOTE_SIZES[0], ADMIT_CARD: ADMIT_NOTE_SIZES[0] } as const;

/** Height of a front box of bold bullets (the standard lines, or a statement of entry's own note). */
export function entryNotesHeight(notes: string[], size = ENTRY_NOTE_SIZES[0]): number {
    const lh = size * TIMES_DEFAULT_LH.b;
    return FRONT_BOX.chrome + notes.reduce((h, n, i) => h + timesLines(n.toUpperCase(), 'b', size, FRONT_BOX.entryTextW) * lh + (i ? 2 : 0), 0);
}

/** Height of the admit card's numbered NOTE box (Times Roman, line height 1.3). */
export function admitNotesHeight(notes: string[], size = ADMIT_NOTE_SIZES[0]): number {
    return (
        FRONT_BOX.chrome +
        FRONT_BOX.admitHeading +
        notes.reduce((h, n, i) => h + timesLines(n.toUpperCase(), 'r', size, FRONT_BOX.admitTextW) * size * 1.3 + (i ? 1.5 : 0), 0)
    );
}

export interface TableFit {
    /** Row padding, top and bottom. */
    pv: number;
    /** Font size of the paper rows. */
    size: number;
}

/**
 * Row padding and text size that keep the paper rows inside `budget` points: the Sr I
 * spacing when there is room, then tighter rows, then smaller text (never under 6.5pt).
 */
export function fitTable(lineCounts: number[], budget: number): TableFit {
    const pv = rowPadding(lineCounts, budget);
    const lines = lineCounts.reduce((a, b) => a + b, 0);
    const rows = Math.max(lineCounts.length, 1);
    if (lines * LINE_H + rows * 2 * pv <= budget) return { pv, size: 10 };
    const size = Math.max(6.5, Math.floor(((10 * (budget - rows * 3)) / (lines * LINE_H)) * 10) / 10);
    return { pv: 1.5, size };
}

/** Height the paper rows take at a fit (LINE_H is a 10pt line). */
export function tableHeight(lineCounts: number[], fit: TableFit): number {
    const lines = lineCounts.reduce((a, b) => a + b, 0);
    return (lines * LINE_H * fit.size) / 10 + Math.max(lineCounts.length, 1) * 2 * fit.pv;
}

export interface FrontFit extends TableFit {
    /** Size the front note prints at. */
    noteSize: number;
}

/**
 * TAFSD-555: the paper rows and an own front note share the room the rows and the standard
 * box leave, plus the page's spare space. With the standard lines nothing changes (TAFSD-528).
 * With a note: the note takes the spare room first, the rows never grow past their own budget,
 * and when it is too tight both shrink together, the rows staying `lead` points larger.
 */
function fitFront(
    lineCounts: number[],
    notes: string[],
    o: { rowsBudget: number; standardH: number; spare: number; sizes: number[]; noteH: (size: number) => number; lead: number; slack: number },
): FrontFit {
    const standard = fitTable(lineCounts, o.rowsBudget);
    if (!notes.length) return { ...standard, noteSize: o.sizes[0] };
    const room = o.rowsBudget + o.standardH + o.spare - o.slack;
    let last: FrontFit = { pv: 1.5, size: 6.5, noteSize: o.sizes[o.sizes.length - 1] };
    for (const noteSize of o.sizes) {
        const noteH = o.noteH(noteSize);
        const table = fitTable(lineCounts, Math.min(o.rowsBudget, room - noteH));
        last = { ...table, noteSize };
        if (table.size >= Math.min(10, noteSize + o.lead) && tableHeight(lineCounts, table) + noteH <= room) return last;
    }
    return last;
}

/** The admit card's table and front note (numbered under NOTE:), the table staying a step larger. */
export function fitAdmit(lineCounts: number[], notes: string[], slack = 0): FrontFit {
    return fitFront(lineCounts, notes, {
        rowsBudget: ADMIT_BUDGET - STANDARD_NOTES_H,
        standardH: entryNotesHeight(standardFrontNotes({ docType: 'ADMIT_CARD' })),
        spare: FRONT_SPARE.admit,
        sizes: ADMIT_NOTE_SIZES,
        noteH: (size) => admitNotesHeight(notes, size),
        // 8.5pt notes want a full 10pt table.
        lead: 1.5,
        slack,
    });
}

/** A statement of entry's table and front note (bold bullets), the table at least as large as the note. */
export function fitEntry(lineCounts: number[], notes: string[], slack = 0): FrontFit {
    return fitFront(lineCounts, notes, {
        rowsBudget: ROWS_BUDGET,
        standardH: entryNotesHeight(standardFrontNotes({ docType: 'STATEMENT_OF_ENTRY' })),
        spare: FRONT_SPARE.entry,
        sizes: ENTRY_NOTE_SIZES,
        noteH: (size) => entryNotesHeight(notes, size),
        lead: 0.5,
        slack,
    });
}

/** The fit a document's front page prints with. */
export function frontFit(d: Pick<ExamDocPage, 'docType' | 'papers' | 'frontNotes' | 'frontSlack'>): FrontFit {
    const lines = paperLines(d);
    return d.docType === 'STATEMENT_OF_ENTRY' ? fitEntry(lines, d.frontNotes, d.frontSlack ?? 0) : fitAdmit(lines, d.frontNotes, d.frontSlack ?? 0);
}

/** Text size that keeps a value on one line of its box (about 0.66em a capital, Times Bold). */
export function fitOneLine(text: string, boxWidth: number, base = 10.5, min = 7): number {
    const fits = Math.floor(boxWidth / (base * 0.66));
    return text.length <= fits ? base : Math.max(min, Math.floor(((base * fits) / text.length) * 10) / 10);
}

/** Row padding that keeps the front page on one sheet: the Sr I spacing when there is room. */
export function rowPadding(lineCounts: number[], budget = ROWS_BUDGET): number {
    const lines = lineCounts.reduce((a, b) => a + b, 0);
    const pv = (budget - lines * LINE_H) / (2 * Math.max(lineCounts.length, 1));
    return Math.max(1.5, Math.min(6.5, Math.floor(pv * 10) / 10));
}

export const paperLines = (d: Pick<ExamDocPage, 'docType' | 'papers'>) =>
    d.papers.map((p) => subjectLines(p.subject, d.docType === 'STATEMENT_OF_ENTRY' ? SUBJECT_CHARS.entry : SUBJECT_CHARS.admit));

function PapersTable({ d }: { d: ExamDocPage }) {
    const entry = d.docType === 'STATEMENT_OF_ENTRY';
    const { pv, size } = frontFit(d);
    const W: Record<string, number | null> = { code: 84, subject: null, day: 84, date: 104, dayDate: 178, time: 74 };
    const cs = (k: string) => (W[k] ? { width: W[k] } : { flex: 1, textAlign: 'left' as const, paddingLeft: 8 });
    const cell = (v: string | null) => (v && v.trim() ? v : '-');
    const td = (k: string, v: string, extra: { fontFamily?: string } = {}) => (
        <Text style={[s.td, cs(k), s.vline, { paddingVertical: pv, fontSize: size }, extra]}>{v}</Text>
    );
    return (
        <View style={[s.table, { marginTop: 12 }]}>
            {entry ? (
                <View style={s.thRow}>
                    <Text style={[s.th, cs('code')]}>SYLLABUS / COMPONENT CODE</Text>
                    <Text style={[s.th, cs('subject'), s.vline, { textAlign: 'left' }]}>SYLLABUS AND COMPONENT TITLE</Text>
                    <Text style={[s.th, cs('day'), s.vline]}>ASSESSMENT DAY</Text>
                    <Text style={[s.th, cs('date'), s.vline]}>ASSESSMENT DATE</Text>
                    <Text style={[s.th, cs('time'), s.vline]}>TIME</Text>
                </View>
            ) : (
                <View style={s.thRow}>
                    <Text style={[s.th, cs('subject'), { textAlign: 'left' }]}>SUBJECT</Text>
                    <Text style={[s.th, cs('dayDate'), s.vline]}>DAY & DATE</Text>
                    <Text style={[s.th, cs('time'), s.vline]}>TIME</Text>
                </View>
            )}
            {d.papers.map((p, i) =>
                entry ? (
                    <View key={i} style={s.tr} wrap={false}>
                        <Text style={[s.td, cs('code'), { paddingVertical: pv, fontSize: size }]}>{cell(p.code)}</Text>
                        {td('subject', p.subject.toUpperCase(), { fontFamily: F.b })}
                        {td('day', p.day.toUpperCase())}
                        {td('date', p.date)}
                        {td('time', cell(p.time))}
                    </View>
                ) : (
                    <View key={i} style={s.tr} wrap={false}>
                        <Text style={[s.td, cs('subject'), { fontFamily: F.b, paddingVertical: pv, fontSize: size }]}>{p.subject.toUpperCase()}</Text>
                        {td('dayDate', p.dayDate)}
                        {td('time', cell(p.time))}
                    </View>
                ),
            )}
        </View>
    );
}

/** The front box as bold bullets: the standard lines, or a statement of entry's own front note. */
function FrontNotes({ lines, size = 9.5 }: { lines: string[]; size?: number }) {
    return (
        <View style={{ marginTop: 9, borderWidth: 0.9, borderColor: RULE, paddingVertical: 5, paddingHorizontal: 8 }}>
            {lines.map((n, i) => (
                <View key={i} style={[s.row, { alignItems: 'flex-start', marginTop: i ? 2 : 0 }]} wrap={false}>
                    <Text style={{ width: 12, fontSize: size }}>•</Text>
                    <Text style={{ flex: 1, fontFamily: F.b, fontSize: size }}>{n.toUpperCase()}</Text>
                </View>
            ))}
        </View>
    );
}

/** TAFSD-555: the box under the table on the front of either document. */
function FrontNoteBox({ d }: { d: ExamDocPage }) {
    if (!d.frontNotes.length) return <FrontNotes lines={standardFrontNotes(d)} />;
    const { noteSize } = frontFit(d);
    if (d.docType === 'ADMIT_CARD') return <AdmitNotes notes={d.frontNotes} size={noteSize} />;
    return <FrontNotes lines={d.frontNotes} size={noteSize} />;
}

/** The admit card's notes, numbered under NOTE: as on the school's own admit card. */
function AdmitNotes({ notes, size }: { notes: string[]; size: number }) {
    return (
        <View style={{ marginTop: 9, borderWidth: 0.9, borderColor: RULE, paddingVertical: 5, paddingHorizontal: 8 }}>
            <Text style={{ fontFamily: F.b, fontSize: 9, textDecoration: 'underline', marginBottom: 3 }}>NOTE:</Text>
            {notes.map((n, i) => (
                <View key={i} style={[s.row, { alignItems: 'flex-start', marginTop: i ? 1.5 : 0 }]} wrap={false}>
                    <Text style={{ width: 16, fontSize: size, lineHeight: 1.3 }}>{`${i + 1}.`}</Text>
                    <Text style={{ flex: 1, fontSize: size, lineHeight: 1.3 }}>{n.toUpperCase()}</Text>
                </View>
            ))}
        </View>
    );
}

function Footer({ d, page, of, right }: { d: ExamDocPage; page: number; of: number; right?: string }) {
    return (
        <View style={{ marginTop: 6 }}>
            <View style={[s.row, { borderWidth: 0.9, borderColor: RULE, paddingVertical: 3.5, paddingHorizontal: 8, marginBottom: 5 }]}>
                <Text style={{ fontFamily: F.bi, fontSize: 8.5 }}>{`DAY & DATE OF ISSUANCE : ${d.issuedLong.toUpperCase()}`}</Text>
                {right ? <Text style={{ fontFamily: F.bi, fontSize: 8.5, marginLeft: 'auto' }}>{right}</Text> : null}
            </View>
            <View style={s.footerBox}>
                <Text style={s.footCampus}>{d.campusLine}</Text>
                {d.campusAddress || d.campusUan ? (
                    <Text style={s.footText}>{[d.campusAddress, d.campusUan ? `UAN : ${d.campusUan}` : null].filter(Boolean).join('  ·  ')}</Text>
                ) : null}
                <Text style={s.footText}>{d.webLine}</Text>
            </View>
            <Text style={s.sysNote}>
                THIS IS A SYSTEM GENERATED DOCUMENT ISSUED WITHOUT ALTERATION OR ERASURE, AND DOES NOT REQUIRE A SIGNATURE.
            </Text>
            <Text style={s.pageNo}>{pageCountLabel(page, of)}</Text>
        </View>
    );
}

function FrontPage({ d, of }: { d: ExamDocPage; of: number }) {
    return (
        <Page size="A4" style={s.page}>
            <View style={s.frame}>
                <Header d={d} />
                {d.docType === 'ADMIT_CARD' ? <AdmitFields d={d} /> : <EntryFields d={d} />}
                <PapersTable d={d} />
                <FrontNoteBox d={d} />
                <View style={{ flex: 1 }} />
                {/* TAFSD-528: no signature boxes on either document; the footer says none is needed. */}
                <Footer d={d} page={1} of={of} right={of > 1 ? 'PLEASE TURN OVER FOR THE RULES OF ASSESSMENTS' : undefined} />
            </View>
        </Page>
    );
}

/** Usable height and widths of the back page, in points (A4 frame less its header and page number). */
// TAFSD-528: the school's notice sheets have wide side margins and roomy, near double-spaced bullets.
const BACK = { height: 680, bulletW: 439, boxW: 433, subW: 393 };
const BULLET_LH = 1.9;
const NOTICE_SIZES = [11, 10.5, 10, 9.5, 9, 8.5, 8, 7.5];
const SIGN_SIZES = [92, 74, 58, 46, 0];

function linesFor(text: string, widthPt: number, size: number): number {
    // Capitals in Times average about 0.6em wide (measured on the O-III back page).
    return subjectLines(text, Math.max(10, Math.floor(widthPt / (size * 0.6))));
}

/** Font size and no-phones sign size that keep the notice and the schedule's notes on one page. */
export function noticeLayout(notice: Notice, notes: string[]): { size: number; sign: number } {
    const cambridge = notice.style === 'cambridge';
    const itemsH = (size: number) => {
        const lh = size * (cambridge ? 1.3 : BULLET_LH);
        const gap = size * 0.5;
        const w = cambridge ? BACK.boxW : BACK.bulletW;
        let h = 0;
        for (const it of notice.items) {
            h += linesFor(noticeItemText(it), w, size) * lh + gap;
            for (const sub of it.sub ?? []) h += linesFor(sub, BACK.subW, size) * lh + gap;
        }
        if (notes.length) {
            if (cambridge) h += size * 1.2; // the gap under the box
            for (const n of notes) h += linesFor(n, BACK.bulletW, size) * size * BULLET_LH + gap;
        }
        return h + (cambridge ? 28 : 0); // the box's padding
    };
    // The sign is part of the Cambridge notice: keep it while the text can stay 9pt or more.
    const fits = (size: number, sign: number) => itemsH(size) + (sign ? sign + 12 : 0) <= BACK.height;
    for (const sign of cambridge ? SIGN_SIZES : [0]) {
        const size = NOTICE_SIZES.find((sz) => (sign ? sz >= 9 : true) && fits(sz, sign));
        if (size) return { size, sign };
    }
    return { size: NOTICE_SIZES[NOTICE_SIZES.length - 1], sign: 0 };
}

/** The no-phones sign from the Cambridge notice, redrawn: phone tilted left, slash from top right. */
function NoPhones({ size }: { size: number }) {
    const keys = [0, 1, 2, 3].flatMap((r) => [0, 1, 2].map((c) => ({ x: 42 + c * 8, y: 50 + r * 7.5 })));
    return (
        <Svg width={size} height={size} viewBox="0 0 100 100">
            <Circle cx={50} cy={50} r={44} fill="#ffffff" stroke="#e01b1b" strokeWidth={9} />
            <G transform="translate(50 50) rotate(-30) translate(-50 -50)">
                <Rect x={56} y={8} width={4} height={14} fill="#111111" />
                <Rect x={33} y={20} width={34} height={64} rx={6} ry={6} fill="#111111" />
                <Rect x={38} y={26} width={24} height={16} rx={2} ry={2} fill="#ffffff" />
                {keys.map((k, i) => (
                    <Rect key={i} x={k.x - 3} y={k.y - 2.2} width={6} height={4.4} rx={2.2} ry={2.2} fill="#ffffff" />
                ))}
            </G>
            <Line x1={81} y1={19} x2={19} y2={81} stroke="#e01b1b" strokeWidth={9} />
        </Svg>
    );
}

function BulletList({ items, size }: { items: string[]; size: number }) {
    return (
        <View>
            {items.map((n, i) => (
                <View key={i} style={[s.row, { alignItems: 'flex-start', marginTop: i ? size * 0.5 : 0 }]} wrap={false}>
                    <Text style={{ width: 18, fontSize: size, lineHeight: BULLET_LH }}>•</Text>
                    <Text style={{ flex: 1, fontFamily: F.i, fontSize: size, lineHeight: BULLET_LH }}>{n.toUpperCase()}</Text>
                </View>
            ))}
        </View>
    );
}

function CambridgeRules({ items, size, sign }: { items: NoticeItem[]; size: number; sign: number }) {
    return (
        <View style={{ borderWidth: 0.9, borderColor: RULE, paddingVertical: 14, paddingHorizontal: 14 }}>
            {items.map((it, i) => (
                <View key={i} style={{ marginTop: i ? size * 0.5 : 0 }} wrap={false}>
                    <View style={[s.row, { alignItems: 'flex-start' }]}>
                        <Text style={{ width: 20, fontSize: size, lineHeight: 1.3 }}>{`${i + 1}.`}</Text>
                        <Text style={{ flex: 1, fontSize: size, lineHeight: 1.3, textAlign: 'justify' }}>
                            {it.parts.map((p, j) => (
                                <Text key={j} style={p.bold ? { fontFamily: F.b } : {}}>{p.text}</Text>
                            ))}
                        </Text>
                    </View>
                    {(it.sub ?? []).map((t, j) => (
                        <View key={j} style={[s.row, { alignItems: 'flex-start', marginTop: size * 0.5, paddingLeft: 40 }]}>
                            <Text style={{ width: 22, fontSize: size, lineHeight: 1.3 }}>•</Text>
                            <Text style={{ flex: 1, fontSize: size, lineHeight: 1.3, textAlign: 'justify' }}>{t}</Text>
                        </View>
                    ))}
                    {it.sub && sign ? (
                        <View style={{ alignItems: 'center', marginTop: 10 }}>
                            <NoPhones size={sign} />
                        </View>
                    ) : null}
                </View>
            ))}
        </View>
    );
}

/** The back of a statement of entry: the segment's Notice to Candidates, then the schedule's notes. */
function NoticePage({ d, notice, of }: { d: ExamDocPage; notice: Notice; of: number }) {
    const { size, sign } = noticeLayout(notice, d.notes);
    return (
        <Page size="A4" style={s.page}>
            {/* TAFSD-528: the same notice for everyone, so no name, C.C., class or serial on it. */}
            {/* No border round the page: the school's notice sheets have none. */}
            <View style={s.backFrame}>
                <Text style={{ fontFamily: F.b, fontSize: 22, textAlign: 'center', marginTop: 40 }}>{notice.title}</Text>
                <Text style={{ fontFamily: F.b, fontSize: 12.5, textAlign: 'center', marginTop: 8, marginBottom: 16 }}>{notice.subtitle}</Text>
                <View style={{ paddingHorizontal: notice.style === 'cambridge' ? 30 : 36 }}>
                    {/* The schedule's notes (the PTM line…) are the last bullets of the list, as on the school's sheets. */}
                    {notice.style === 'cambridge' ? (
                        <>
                            <CambridgeRules items={notice.items} size={size} sign={sign} />
                            {d.notes.length ? (
                                <View style={{ marginTop: size * 1.2 }}>
                                    <BulletList items={d.notes} size={size} />
                                </View>
                            ) : null}
                        </>
                    ) : (
                        <BulletList items={[...notice.items.map(noticeItemText), ...d.notes]} size={size} />
                    )}
                </View>
                <View style={{ flex: 1 }} />
                <Text style={s.pageNo}>{pageCountLabel(2, of)}</Text>
            </View>
        </Page>
    );
}

/** A statement of entry is two pages (the notice on the back); an admit card is one. */
export function ExamDocPages({ d }: { d: ExamDocPage }) {
    if (!d.notice) return <FrontPage d={d} of={1} />;
    return (
        <>
            <FrontPage d={d} of={2} />
            <NoticePage d={d} notice={d.notice} of={2} />
        </>
    );
}

export function ExamDocumentsPDF({ pages, title }: { pages: ExamDocPage[]; title: string }) {
    return (
        <Document title={title} author="TAFS">
            {pages.map((d, i) => (
                <ExamDocPages key={`${d.cc}-${i}`} d={d} />
            ))}
        </Document>
    );
}

/**
 * TAFSD-555: the front page alone, exactly as it prints in a document. settleFrontFit renders it
 * to check the page holds on one sheet; the schedule editor's live preview shows it.
 */
export function ExamFrontPagePDF({ d, title = 'Front page' }: { d: ExamDocPage; title?: string }) {
    return (
        <Document title={title} author="TAFS">
            <FrontPage d={d} of={d.notice ? 2 : 1} />
        </Document>
    );
}
