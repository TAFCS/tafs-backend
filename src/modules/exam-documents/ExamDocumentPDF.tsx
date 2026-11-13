import React from 'react';
import * as path from 'path';
import { Document, Font, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { ExamDocType } from './exam-document-rules';

/**
 * TAFSD-510: admit card (VI–X) and statement of entry (every other class).
 * Layouts are the TAFSD-493 mockups (scripts/exam-docs-sample.cjs), set in Times
 * like the leaving certificate. One page per student; one PDF per request.
 */

// Never hyphenate ("OB-TAINED").
Font.registerHyphenationCallback((word) => [word]);

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
    date: string;
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

const s = StyleSheet.create({
    page: { padding: 18, fontFamily: F.r, fontSize: 10, color: INK },
    frame: { flex: 1, borderWidth: 1.2, borderColor: RULE, paddingTop: 10, paddingHorizontal: 16, paddingBottom: 6 },
    logos: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    logoL: { width: 52, height: 50 },
    logoMotto: { width: 100, height: 29, marginTop: 4 },
    logoCambridge: { width: 118, height: 26.9, marginTop: 5 },
    school: { fontFamily: F.b, fontSize: 18, textAlign: 'center', letterSpacing: 0.3, marginTop: 4 },
    titleLine: { fontFamily: F.b, fontSize: 11.5, textAlign: 'center', marginTop: 1.5 },
    docTitle: { fontFamily: F.b, fontSize: 14, textAlign: 'center', marginTop: 4, letterSpacing: 2 },
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
    td: { fontSize: 10, paddingVertical: 3.1, paddingHorizontal: 5, textAlign: 'center' },
    vline: { borderLeftWidth: 0.5, borderLeftColor: '#9a9a9a' },
    signBox: { borderWidth: 0.9, borderColor: RULE, flexDirection: 'column', paddingBottom: 6, paddingHorizontal: 6 },
    sign: { flex: 1, alignItems: 'center', marginHorizontal: 14 },
    signLine: { alignSelf: 'stretch', borderTopWidth: 0.8, borderTopColor: RULE, marginBottom: 3 },
    signLabel: { fontFamily: F.b, fontSize: 8.5, textAlign: 'center', letterSpacing: 0.3 },
    footerBox: { borderWidth: 0.9, borderColor: RULE, paddingVertical: 4, alignItems: 'center' },
    footCampus: { fontFamily: F.b, fontSize: 9, letterSpacing: 0.4 },
    footText: { fontSize: 7.5, marginTop: 1.5, textAlign: 'center', color: MUTED },
    sysNote: { fontFamily: F.i, fontSize: 7.5, textAlign: 'center', marginTop: 3, color: MUTED },
});

const SIGNATURES = [
    ['HEAD OF THE SEGMENT', 'ACADEMIC DIRECTRESS', 'HEAD OF THE INSTITUTION'],
    ['ACCOUNTANT', 'DIRECTRESS ADMIN. & P.-G.', 'DIRECTRESS FINANCE'],
];

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

function Field(p: { label: string; value: string; labelW?: number; boxW?: number; center?: boolean; mt?: number }) {
    const { label, value, labelW = 116, boxW, center, mt = 5 } = p;
    return (
        <View style={[s.row, { marginTop: mt }]}>
            <Text style={[s.label, { width: labelW }]}>{`${label} :`}</Text>
            <View style={[s.box, boxW ? { width: boxW } : { flex: 1 }]}>
                <Text style={[s.boxText, center ? { textAlign: 'center' } : {}]}>{value || '-'}</Text>
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

function Notes({ notes, compact }: { notes: string[]; compact: boolean }) {
    if (!notes.length) return null;
    const size = compact ? 7.6 : 8.3;
    return (
        <View style={{ marginTop: 7, borderWidth: 0.9, borderColor: RULE, paddingVertical: 4, paddingHorizontal: 8 }}>
            <Text style={{ fontFamily: F.b, fontSize: 9, textDecoration: 'underline', marginBottom: 2 }}>NOTE:</Text>
            {notes.map((n, i) => (
                <View key={i} style={[s.row, { alignItems: 'flex-start', marginBottom: 1.2 }]}>
                    <Text style={{ width: 14, fontSize: size }}>{`${i + 1}.`}</Text>
                    <Text style={{ flex: 1, fontSize: size, lineHeight: 1.2 }}>{n}</Text>
                </View>
            ))}
        </View>
    );
}

function Signatures({ compact }: { compact: boolean }) {
    return (
        <View style={[s.signBox, { marginTop: 6 }]}>
            {SIGNATURES.map((labels, i) => (
                <View key={i} style={{ flexDirection: 'row', marginTop: compact ? 16 : 20 }}>
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

function Footer({ d }: { d: ExamDocPage }) {
    return (
        <View style={{ marginTop: 6 }}>
            <View style={[s.row, { borderWidth: 0.9, borderColor: RULE, paddingVertical: 3.5, paddingHorizontal: 8, marginBottom: 5 }]}>
                <Text style={{ fontFamily: F.bi, fontSize: 8.5 }}>{`Day & date of issuance : ${d.issuedLong}`}</Text>
                <Text style={{ fontFamily: F.bi, fontSize: 8.5, marginLeft: 'auto' }}>Page 1 of 1</Text>
            </View>
            <View style={s.footerBox}>
                <Text style={s.footCampus}>{d.campusLine}</Text>
                {d.addressLines.map((l, i) => (
                    <Text key={i} style={s.footText}>{l}</Text>
                ))}
            </View>
            <Text style={s.sysNote}>
                This is a system generated document issued without alteration or erasure, and does not require a signature.
            </Text>
        </View>
    );
}

function StudentBlock({ d }: { d: ExamDocPage }) {
    const klass = d.sectionName ? `${d.className} – ${d.sectionName}` : d.className;
    return (
        <View style={[s.row, { marginTop: 10, alignItems: 'flex-start' }]}>
            <View style={{ flex: 1, paddingRight: 14 }}>
                <View style={s.row}>
                    <Field label="CLASS" value={klass} labelW={44} boxW={92} center mt={0} />
                    <View style={{ width: 12 }} />
                    <Field label="C.C. #" value={d.cc} labelW={42} boxW={64} center mt={0} />
                    <View style={{ width: 12 }} />
                    <Field label="G.R. #" value={d.gr} labelW={42} boxW={64} center mt={0} />
                </View>
                <Field label={d.docType === 'STATEMENT_OF_ENTRY' ? "CANDIDATE'S NAME" : "STUDENT'S NAME"} value={d.name} mt={9} />
                <Field label="FATHER'S NAME" value={d.father} />
                <View style={s.row}>
                    <Field label="DATE OF BIRTH" value={d.dob} boxW={110} center />
                    <View style={{ flex: 1 }} />
                    {d.gender ? <Field label="GENDER" value={d.gender} labelW={50} boxW={40} center /> : null}
                </View>
            </View>
            <Photo d={d} />
        </View>
    );
}

function AdmitCardTable({ papers, compact }: { papers: ExamPaperLine[]; compact: boolean }) {
    const pv = compact ? 2.4 : 3.1;
    const W: Record<string, number | null> = { subject: null, date: 150, time: 120 };
    const cs = (k: string) => (W[k] ? { width: W[k] as number } : { flex: 1 });
    return (
        <View style={[s.table, { marginTop: 10 }]}>
            <View style={s.thRow}>
                <Text style={[s.th, cs('subject')]}>SUBJECT</Text>
                <Text style={[s.th, cs('date'), s.vline]}>DAY & DATE</Text>
                <Text style={[s.th, cs('time'), s.vline]}>TIME</Text>
            </View>
            {papers.map((p, i) => (
                <View key={i} style={s.tr} wrap={false}>
                    <Text style={[s.td, cs('subject'), { fontFamily: F.b, paddingVertical: pv }]}>{p.subject.toUpperCase()}</Text>
                    <Text style={[s.td, cs('date'), s.vline, { paddingVertical: pv }]}>{`${p.day}, ${p.date}`}</Text>
                    <Text style={[s.td, cs('time'), s.vline, { paddingVertical: pv }]}>{p.time}</Text>
                </View>
            ))}
        </View>
    );
}

function EntryTable({ papers, compact }: { papers: ExamPaperLine[]; compact: boolean }) {
    const pv = compact ? 2.6 : 3.6;
    const withCodes = papers.some((p) => p.code);
    const W: Record<string, number | null> = { code: withCodes ? 84 : 0, subject: null, day: 86, date: 80, time: 78 };
    const cs = (k: string) => (W[k] ? { width: W[k] as number } : { flex: 1, textAlign: 'left' as const, paddingLeft: 8 });
    return (
        <View style={[s.table, { marginTop: 10 }]}>
            <View style={s.thRow}>
                {withCodes ? <Text style={[s.th, cs('code')]}>SYLLABUS / COMPONENT CODE</Text> : null}
                <Text style={[s.th, cs('subject'), withCodes ? s.vline : {}, { textAlign: 'left' }]}>SYLLABUS AND COMPONENT TITLE</Text>
                <Text style={[s.th, cs('day'), s.vline]}>ASSESSMENT DAY</Text>
                <Text style={[s.th, cs('date'), s.vline]}>ASSESSMENT DATE</Text>
                <Text style={[s.th, cs('time'), s.vline]}>TIME</Text>
            </View>
            {papers.map((p, i) => (
                <View key={i} style={s.tr} wrap={false}>
                    {withCodes ? <Text style={[s.td, cs('code'), { paddingVertical: pv }]}>{p.code || ''}</Text> : null}
                    <Text style={[s.td, cs('subject'), withCodes ? s.vline : {}, { fontFamily: F.b, paddingVertical: pv }]}>{p.subject.toUpperCase()}</Text>
                    <Text style={[s.td, cs('day'), s.vline, { paddingVertical: pv }]}>{p.day.toUpperCase()}</Text>
                    <Text style={[s.td, cs('date'), s.vline, { paddingVertical: pv }]}>{p.date}</Text>
                    <Text style={[s.td, cs('time'), s.vline, { paddingVertical: pv }]}>{p.time}</Text>
                </View>
            ))}
        </View>
    );
}

/** Long schedules (O-III's split papers, ten-plus notes) tighten up to stay on one page. */
function isCompact(d: ExamDocPage): boolean {
    const noteLines = d.notes.reduce((n, t) => n + Math.ceil(t.length / 105), 0);
    return d.papers.length + noteLines > 18;
}

export function ExamDocPageView({ d }: { d: ExamDocPage }) {
    const compact = isCompact(d);
    return (
        <Page size="A4" style={s.page}>
            <View style={s.frame}>
                <Header d={d} />
                <StudentBlock d={d} />
                {d.docType === 'ADMIT_CARD' ? (
                    <AdmitCardTable papers={d.papers} compact={compact} />
                ) : (
                    <EntryTable papers={d.papers} compact={compact} />
                )}
                <Notes notes={d.notes} compact={compact} />
                <View style={{ flex: 1 }} />
                <Signatures compact={compact} />
                <Footer d={d} />
            </View>
        </Page>
    );
}

export function ExamDocumentsPDF({ pages, title }: { pages: ExamDocPage[]; title: string }) {
    return (
        <Document title={title} author="TAFS">
            {pages.map((d, i) => (
                <ExamDocPageView key={`${d.cc}-${i}`} d={d} />
            ))}
        </Document>
    );
}
