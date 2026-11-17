import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { Document, Font, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { ExamDocType } from './exam-document-rules';

/**
 * TAFSD-510: admit card (VI–X) and statement of entry (every other class).
 * TAFSD-528: both follow the A Level Sr I statement of entry the school signed off
 * (scripts/exam-docs-sample.cjs, StatementOfEntry): set in Times, school name and
 * document title in Stencil. Each student gets a front page and, when the schedule
 * has notes, a back page with the rules of assessments, numbered "PAGE # 01 OF 02".
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
    /** "December 22, 2026" (statement of entry) */
    date: string;
    /** "Monday, 28-09-2026" (admit card) */
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
    photo: string | null;
    initials: string;
    papers: ExamPaperLine[];
    /** The schedule's notes: the rules of assessments on the back page. */
    notes: string[];
    campusLine: string;
    addressLines: string[];
    issuedLong: string;
}

const F = { r: 'Times-Roman', b: 'Times-Bold', i: 'Times-Italic', bi: 'Times-BoldItalic' };
const INK = '#111111';
const MUTED = '#444444';
const RULE = '#111111';
const SHADE = '#f2f2f2';
const LABEL_W = 142;

const s = StyleSheet.create({
    page: { padding: 18, fontFamily: F.r, fontSize: 10, color: INK },
    frame: { flex: 1, borderWidth: 1.2, borderColor: RULE, paddingTop: 10, paddingHorizontal: 16, paddingBottom: 6 },
    logos: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    logoL: { width: 52, height: 50 },
    logoMotto: { width: 100, height: 29, marginTop: 4 },
    logoCambridge: { width: 118, height: 26.9, marginTop: 5 },
    school: { fontFamily: HEADING_FONT, fontSize: 18, textAlign: 'center', letterSpacing: 0.3, marginTop: 4 },
    docTitle: { fontFamily: HEADING_FONT, fontSize: 14, textAlign: 'center', marginTop: 4, letterSpacing: 2 },
    titleLine: { fontFamily: F.b, fontSize: 11.5, textAlign: 'center', marginTop: 1.5 },
    serial: { fontFamily: F.b, fontSize: 8.5, textAlign: 'right', marginTop: -10, color: MUTED },
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
    signBox: { borderWidth: 0.9, borderColor: RULE, flexDirection: 'column', marginTop: 8, paddingBottom: 8, paddingHorizontal: 6 },
    sign: { flex: 1, alignItems: 'center', marginHorizontal: 14 },
    signLine: { alignSelf: 'stretch', borderTopWidth: 0.8, borderTopColor: RULE, marginBottom: 3 },
    signLabel: { fontFamily: F.b, fontSize: 8.5, textAlign: 'center', letterSpacing: 0.3 },
    footerBox: { borderWidth: 0.9, borderColor: RULE, paddingVertical: 4, alignItems: 'center' },
    footCampus: { fontFamily: F.b, fontSize: 9, letterSpacing: 0.4 },
    footText: { fontSize: 7.5, marginTop: 1.5, textAlign: 'center', color: MUTED },
    sysNote: { fontFamily: F.i, fontSize: 7.5, textAlign: 'center', marginTop: 3, color: MUTED },
    pageNo: { fontFamily: F.b, fontSize: 9, textAlign: 'center', marginTop: 3, letterSpacing: 0.3 },
});

const SIGNATURES = [
    ['HEAD OF THE SEGMENT', 'ACADEMIC DIRECTRESS', 'HEAD OF THE INSTITUTION'],
    ['ACCOUNTANT', 'DIRECTRESS ADMIN. & P.-G.', 'DIRECTRESS FINANCE'],
];

const two = (n: number) => String(n).padStart(2, '0');

/** "PAGE # 01 OF 02" */
export function pageCountLabel(page: number, of: number): string {
    return `PAGE # ${two(page)} OF ${two(of)}`;
}

/** The two lines under the table on the front page, as on the Sr I statement of entry. */
export function frontNotes(d: Pick<ExamDocPage, 'docType'>): string[] {
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
            <Text style={s.serial}>S. # {d.serial}</Text>
        </View>
    );
}

/** Values sit at the left of their box; an empty box shows a dash in its centre. */
function Field(p: { label: string; value: string; labelW?: number; boxW?: number; mt?: number }) {
    const { label, value, labelW = LABEL_W, boxW, mt = 7 } = p;
    const empty = !value.trim();
    return (
        <View style={[s.row, { marginTop: mt }]}>
            <Text style={[s.label, { width: labelW }]}>{`${label} :`}</Text>
            <View style={[s.box, boxW ? { width: boxW } : { flex: 1 }]}>
                <Text style={[s.boxText, { textAlign: empty ? 'center' : 'left' }]}>{empty ? '-' : value}</Text>
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
                <Field label="C.C. # / G.R. #" value={[d.cc, d.gr || '-'].join(' / ')} boxW={120} mt={0} />
                <Field label="CANDIDATE'S NAME" value={d.name} />
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
                    <Field label="CLASS" value={klassOf(d)} labelW={44} boxW={88} mt={0} />
                    <View style={{ flex: 1 }} />
                    <Field label="C.C. #" value={d.cc} labelW={42} boxW={66} mt={0} />
                    <View style={{ flex: 1 }} />
                    <Field label="G.R. #" value={d.gr} labelW={42} boxW={66} mt={0} />
                </View>
                <Field label="STUDENT'S NAME" value={d.name} />
                <Field label="FATHER'S NAME" value={d.father} />
                <View style={s.row}>
                    <Field label="DATE OF BIRTH" value={d.dob} boxW={120} />
                    <View style={{ flex: 1 }} />
                    <Field label="GENDER" value={d.gender ?? ''} labelW={50} boxW={40} />
                </View>
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

/** Row padding that keeps the front page on one sheet: the Sr I spacing when there is room. */
export function rowPadding(lineCounts: number[]): number {
    const lines = lineCounts.reduce((a, b) => a + b, 0);
    const pv = (ROWS_BUDGET - lines * LINE_H) / (2 * Math.max(lineCounts.length, 1));
    return Math.max(1.5, Math.min(6.5, Math.floor(pv * 10) / 10));
}

function PapersTable({ d }: { d: ExamDocPage }) {
    const entry = d.docType === 'STATEMENT_OF_ENTRY';
    const pv = rowPadding(d.papers.map((p) => subjectLines(p.subject, entry ? SUBJECT_CHARS.entry : SUBJECT_CHARS.admit)));
    const W: Record<string, number | null> = { code: 84, subject: null, day: 84, date: 104, dayDate: 150, time: 74 };
    const cs = (k: string) => (W[k] ? { width: W[k] as number } : { flex: 1, textAlign: 'left' as const, paddingLeft: 8 });
    const cell = (v: string | null) => (v && v.trim() ? v : '-');
    const td = (k: string, v: string, extra: { fontFamily?: string } = {}) => (
        <Text style={[s.td, cs(k), s.vline, { paddingVertical: pv }, extra]}>{v}</Text>
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
                        <Text style={[s.td, cs('code'), { paddingVertical: pv }]}>{cell(p.code)}</Text>
                        {td('subject', p.subject.toUpperCase(), { fontFamily: F.b })}
                        {td('day', p.day.toUpperCase())}
                        {td('date', p.date)}
                        {td('time', cell(p.time))}
                    </View>
                ) : (
                    <View key={i} style={s.tr} wrap={false}>
                        <Text style={[s.td, cs('subject'), { fontFamily: F.b, paddingVertical: pv }]}>{p.subject.toUpperCase()}</Text>
                        {td('dayDate', p.dayDate)}
                        {td('time', cell(p.time))}
                    </View>
                ),
            )}
        </View>
    );
}

function FrontNotes({ d }: { d: ExamDocPage }) {
    return (
        <View style={{ marginTop: 9, borderWidth: 0.9, borderColor: RULE, paddingVertical: 5, paddingHorizontal: 8 }}>
            {frontNotes(d).map((n, i) => (
                <View key={i} style={[s.row, { alignItems: 'flex-start', marginTop: i ? 2 : 0 }]}>
                    <Text style={{ width: 12, fontSize: 9.5 }}>•</Text>
                    <Text style={{ flex: 1, fontFamily: F.b, fontSize: 9.5 }}>{n}</Text>
                </View>
            ))}
        </View>
    );
}

function Signatures() {
    return (
        <View style={s.signBox}>
            {SIGNATURES.map((labels, i) => (
                <View key={i} style={{ flexDirection: 'row', marginTop: 26 }}>
                    {labels.map((l) => (
                        <View key={l} style={s.sign}>
                            <View style={s.signLine} />
                            <Text style={s.signLabel}>{l}</Text>
                        </View>
                    ))}
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
                {d.addressLines.map((l, i) => (
                    <Text key={i} style={s.footText}>{l.toUpperCase()}</Text>
                ))}
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
                <FrontNotes d={d} />
                <View style={{ flex: 1 }} />
                <Signatures />
                <Footer d={d} page={1} of={of} right={of > 1 ? 'PLEASE TURN OVER FOR THE RULES OF ASSESSMENTS' : undefined} />
            </View>
        </Page>
    );
}

/** The back page: who it belongs to, then the schedule's notes. */
function RulesPage({ d, of }: { d: ExamDocPage; of: number }) {
    const size = d.notes.length > 12 ? 9.5 : 10.5;
    return (
        <Page size="A4" style={s.page}>
            <View style={s.frame}>
                <Header d={d} />
                <Field label={d.docType === 'ADMIT_CARD' ? "STUDENT'S NAME" : "CANDIDATE'S NAME"} value={d.name} mt={12} />
                <View style={s.row}>
                    <Field label="CLASS" value={klassOf(d)} boxW={120} />
                    <View style={{ flex: 1 }} />
                    <Field label="C.C. #" value={d.cc} labelW={42} boxW={66} />
                    <View style={{ width: 14 }} />
                    <Field label="G.R. #" value={d.gr} labelW={42} boxW={66} />
                </View>
                <Text style={[s.docTitle, { fontFamily: F.b, fontSize: 13, marginTop: 16, letterSpacing: 1.5 }]}>RULES OF ASSESSMENTS</Text>
                <View style={{ marginTop: 8, borderWidth: 0.9, borderColor: RULE, paddingVertical: 8, paddingHorizontal: 10 }}>
                    {d.notes.map((n, i) => (
                        <View key={i} style={[s.row, { alignItems: 'flex-start', marginTop: i ? 5 : 0 }]} wrap={false}>
                            <Text style={{ width: 20, fontFamily: F.b, fontSize: size }}>{`${i + 1}.`}</Text>
                            <Text style={{ flex: 1, fontSize: size, lineHeight: 1.3 }}>{n.toUpperCase()}</Text>
                        </View>
                    ))}
                </View>
                <View style={{ flex: 1 }} />
                <Footer d={d} page={2} of={of} />
            </View>
        </Page>
    );
}

export function ExamDocPages({ d }: { d: ExamDocPage }) {
    const of = d.notes.length ? 2 : 1;
    return (
        <>
            <FrontPage d={d} of={of} />
            {of > 1 ? <RulesPage d={d} of={of} /> : null}
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
