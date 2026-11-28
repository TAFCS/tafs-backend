import { EXAM_LOGO, ExamDocPage } from './ExamDocumentPDF';
import { docTypeForClass, examGroup, formatSerial, isSecondaryClass } from './exam-document-rules';
import { backPageNotes, noticeForSchedule } from './exam-notices';
import { cleanFooterLines } from '../documents/campus-footer';

/**
 * TAFSD-528: what one student's admit card / statement of entry shows, from plain
 * values. Pure, so the service and the preview script (scripts/exam-docs-preview.ts)
 * render the same thing.
 */

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The school's Cambridge centre number, the same on every campus (confirmed 2026-11-17). */
export const CAMBRIDGE_CENTRE = 'PK 564';
export const WEB_LINE = 'info@tafs.edu.pk  ·  american@cyber.net.pk  ·  www.tafs.edu.pk';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * TAFSD-603: the lines under the campus line in a statement of entry's or admit card's footer.
 * The campus's own document footer when it has one, as typed. Otherwise what printed before it
 * existed: the campus's address in capitals with its UAN (TAFSD-528, TAFSD-549; no address and
 * no UAN, no line), then the school's emails and website.
 */
export function examFooterLines(c: { footer?: readonly string[] | null; address?: string | null; uan?: string | null }): string[] {
    const own = cleanFooterLines(c.footer);
    if (own.length) return own;
    const address = c.address?.trim().toUpperCase() || null;
    const uan = c.uan?.trim() || null;
    const first = [address, uan ? `UAN : ${uan}` : null].filter(Boolean).join('  ·  ');
    return [...(first ? [first] : []), WEB_LINE];
}

export function karachiLong(d: Date): string {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Karachi',
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    }).format(d);
}

/** "2026-2027" → "2026 – 2027" */
export const sessionLabel = (y: string) => y.replace(/\s*-\s*/, ' – ');

/** "22-12-2026" for a 'YYYY-MM-DD' date. Exam documents write dates with dashes only. */
export function dmy(isoDate: string, sep = '-'): string {
    const [y, m, d] = isoDate.slice(0, 10).split('-');
    return [d, m, y].join(sep);
}

/** "December 22, 2026" for a 'YYYY-MM-DD' date. */
export function longDate(isoDate: string): string {
    const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function initialsOf(name: string): string {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0])
        .join('')
        .toUpperCase();
}

export interface ExamDocPageInput {
    schedule: {
        title: string;
        segmentLine: string | null;
        academicYear: string;
        /** The schedule sheet's notes. Only a results / PTM line reaches a document (the back of a statement of entry). */
        notes: string[];
        /** TAFSD-555: the front-of-document note. Empty: the two standard lines. */
        documentNotes?: string[];
        campusName: string;
        campusAddress: string | null;
        /** TAFSD-549: the campus's UAN number, from its record. */
        campusUan?: string | null;
        /** TAFSD-603: the campus's document footer, from its record. Empty: address, UAN and the web line. */
        campusFooter?: string[] | null;
        papers: { class_id: number; paper_date: Date; time_text: string; subject: string; code: string | null }[];
    };
    classId: number;
    className: string;
    sectionName: string | null;
    serialNo: number;
    issuedAt: Date;
    student: {
        cc: number;
        gr: string | null;
        fullName: string;
        father: string;
        dob: Date | null;
        gender: string | null;
        /** From the student's latest admission: "Computer", "Biology"… Feeds the admit card's GROUP. */
        discipline?: string | null;
    };
    photo: string | null;
}

export function buildExamDocPage(p: ExamDocPageInput): ExamDocPage {
    const { schedule, student: s } = p;
    const secondary = isSecondaryClass(p.classId);
    const session = sessionLabel(schedule.academicYear);
    const segment = secondary ? 'SECONDARY SEGMENT' : schedule.segmentLine ? `${schedule.segmentLine.toUpperCase()} SEGMENT` : '';
    const papers = schedule.papers
        .filter((x) => x.class_id === p.classId)
        .map((x) => ({
            day: DAYS[x.paper_date.getUTCDay()],
            // TAFSD-528: dates in capitals: "DECEMBER 22, 2026"; the admit card's "FRIDAY, DECEMBER 11, 2026".
            date: longDate(iso(x.paper_date)).toUpperCase(),
            dayDate: `${DAYS[x.paper_date.getUTCDay()]}, ${longDate(iso(x.paper_date)).toUpperCase()}`,
            time: x.time_text,
            subject: x.subject,
            code: x.code,
        }));
    const notice = secondary ? null : noticeForSchedule(p.classId, schedule.title);
    return {
        docType: docTypeForClass(p.classId),
        serial: formatSerial(p.serialNo),
        school: secondary ? 'THE AMERICAN FOUNDATION SECONDARY SCHOOL' : 'THE AMERICAN FOUNDATION SCHOOL FOR A LEVEL STUDIES',
        title: secondary ? 'ADMIT CARD' : 'STATEMENT OF ENTRY',
        lines: [
            schedule.title.toUpperCase(),
            // An admit card leaves the schedule's line out: it named the classes ("CLASSES IX & X")
            // or the segment, both already on the card (CLASS box, footer).
            ...(schedule.segmentLine && !secondary ? [schedule.segmentLine.toUpperCase()] : []),
            `SESSION : ${session}`,
            // The class is in its own box on both documents (LEVEL beside CENTRE / CANDIDATE #, or CLASS), not the heading.
        ],
        leftLogo: secondary ? EXAM_LOGO.secondary : EXAM_LOGO.alevel,
        rightLogo: secondary ? 'motto' : 'cambridge',
        className: p.className,
        sectionName: p.sectionName,
        cc: String(s.cc),
        gr: s.gr ?? '',
        name: s.fullName.toUpperCase(),
        father: s.father.toUpperCase(),
        dob: s.dob ? dmy(iso(s.dob)) : '',
        gender: s.gender ? s.gender.trim().charAt(0).toUpperCase() : null,
        group: secondary ? examGroup(p.classId, s.discipline) : '',
        photo: p.photo,
        initials: initialsOf(s.fullName),
        papers,
        // TAFSD-555: the schedule sheet's notes stay on the sheet. The front of both documents carries the
        // schedule's own front note (or the standard lines); only a statement of entry has a back page.
        notes: notice ? backPageNotes(notice, schedule.notes) : [],
        frontNotes: (schedule.documentNotes ?? []).map((n) => n.trim()).filter(Boolean),
        centre: CAMBRIDGE_CENTRE,
        notice,
        assessment: schedule.title.toUpperCase(),
        campusLine: [schedule.campusName.toUpperCase(), segment].filter(Boolean).join(' : '),
        footerLines: examFooterLines({
            footer: schedule.campusFooter,
            address: schedule.campusAddress,
            uan: schedule.campusUan,
        }),
        issuedLong: karachiLong(p.issuedAt),
    };
}
