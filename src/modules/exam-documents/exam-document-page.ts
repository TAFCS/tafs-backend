import { EXAM_LOGO, ExamDocPage } from './ExamDocumentPDF';
import { docTypeForClass, formatSerial, isSecondaryClass } from './exam-document-rules';
import { noticeForClass } from './exam-notices';

/**
 * TAFSD-528: what one student's admit card / statement of entry shows, from plain
 * values. Pure, so the service and the preview script (scripts/exam-docs-preview.ts)
 * render the same thing.
 */

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DEFAULT_ADDRESS =
    'C-61, 62, 63, 64 & 65, Block 13, Gulistan-e-Jauhar, Karachi  ·  Phone (92-21) 3476-5111-13  ·  Fax (92-21) 3476-5114';
/** The school's Cambridge centre number, the same on every campus (confirmed 2026-11-17). */
export const CAMBRIDGE_CENTRE = 'PK 564';
export const WEB_LINE = 'info@tafs.edu.pk  ·  american@cyber.net.pk  ·  www.tafs.edu.pk';

const iso = (d: Date) => d.toISOString().slice(0, 10);

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

const titleCase = (w: string) => w.charAt(0) + w.slice(1).toLowerCase();

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
        notes: string[];
        campusName: string;
        campusAddress: string | null;
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
            date: longDate(iso(x.paper_date)),
            dayDate: `${titleCase(DAYS[x.paper_date.getUTCDay()])}, ${dmy(iso(x.paper_date))}`,
            time: x.time_text,
            subject: x.subject,
            code: x.code,
        }));
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
            // The statement of entry names the class in the heading, as on the Sr I sheet ("LEVEL SR. I A").
            ...(secondary ? [] : [`LEVEL ${[p.className, p.sectionName].filter(Boolean).join(' ').toUpperCase()}`]),
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
        photo: p.photo,
        initials: initialsOf(s.fullName),
        papers,
        notes: schedule.notes,
        centre: CAMBRIDGE_CENTRE,
        notice: secondary ? null : noticeForClass(p.classId),
        assessment: schedule.title.toUpperCase(),
        campusLine: [schedule.campusName.toUpperCase(), segment].filter(Boolean).join(' : '),
        addressLines: [schedule.campusAddress?.trim() || DEFAULT_ADDRESS, WEB_LINE],
        issuedLong: karachiLong(p.issuedAt),
    };
}
