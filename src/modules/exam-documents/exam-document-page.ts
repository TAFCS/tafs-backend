import { EXAM_LOGO, ExamDocPage } from './ExamDocumentPDF';
import { docTypeForClass, examGroup, formatSerial, isSecondaryClass } from './exam-document-rules';
import { backPageNotes, noticeForSchedule } from './exam-notices';

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
        // Admit card: every schedule note, under the table. Statement of entry: only what the back page takes.
        notes: notice ? backPageNotes(notice, schedule.notes) : schedule.notes,
        centre: CAMBRIDGE_CENTRE,
        notice,
        assessment: schedule.title.toUpperCase(),
        campusLine: [schedule.campusName.toUpperCase(), segment].filter(Boolean).join(' : '),
        addressLines: [schedule.campusAddress?.trim() || DEFAULT_ADDRESS, WEB_LINE],
        issuedLong: karachiLong(p.issuedAt),
    };
}
