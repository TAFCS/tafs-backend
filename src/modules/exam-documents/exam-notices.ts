import { CLASS_IDS } from '../../common/class-band-ids';

/**
 * TAFSD-528: the "Notice to Candidates" printed on the back of every statement of
 * entry, recreated from the school's own sheets (Notice to Candidates Juniors /
 * SR.I - SR.III / O AND A LEVEL, Nov 2026). Only standing rules live here: lines
 * tied to one sitting (the PTM date, "first semester") come from the schedule's notes,
 * printed under the notice.
 */

export interface NoticePart {
    text: string;
    bold?: boolean;
}

export interface NoticeItem {
    parts: NoticePart[];
    /** Sub-points under the item (the Cambridge "You must not:" list). */
    sub?: string[];
}

export interface Notice {
    /** 'bullets': the school's own italic list (Junior, Senior). 'cambridge': numbered rules in a box with the no-phones sign. */
    style: 'bullets' | 'cambridge';
    title: string;
    subtitle: string;
    items: NoticeItem[];
}

const plain = (text: string): NoticeItem => ({ parts: [{ text }] });
const rich = (...parts: (string | [string])[]): NoticeItem => ({
    parts: parts.map((p) => (typeof p === 'string' ? { text: p } : { text: p[0], bold: true })),
});

/** Stands for the schedule's title in a notice line; see noticeForSchedule. */
export const ASSESSMENT = '{ASSESSMENT}';

const REVIEW = 'KINDLY REVIEW THE WORK DONE AS PER THE SYLLABUS OUTLINE WITH YOUR CHILD SO THAT HE / SHE MAY ACHIEVE THE BEST GRADES.';
const RESOURCES = 'RESOURCE MATERIALS : LECTURES, TEXT BOOKS, REFERENCE BOOKS, REGISTERS / NOTE BOOKS & DLCB PORTAL.';
const SHARED_TAIL = [
    'NO BAGS AND NOTEBOOKS ARE ALLOWED DURING THE ASSESSMENTS.',
    'USAGE OF ASSESSMENT BOARD IS NOT ALLOWED.',
    'NO LENDING OR BORROWING WILL BE ALLOWED, STUDENTS HAVE TO BRING TRANSPARENT POUCHES FOR THEIR STATIONERY.',
    // {ASSESSMENT} is the schedule's title, e.g. "FIRST SEMESTER ASSESSMENTS", as on the school's sheets.
    `IN FAILURE TO BRING STATEMENT OF ENTRY, NO STUDENT WILL BE ALLOWED TO APPEAR IN THE ${ASSESSMENT}.`,
    'IN CASE OF SCHOOL’S CLOSURE DUE TO ANY CITY DISTURBANCE, ASSESSMENT OF THAT DAY WILL BE ASSESSED AFTER THE LAST SCHEDULED ASSESSMENT.',
    'NO PRE OR POST ASSESSMENT WILL BE CONDUCTED.',
    "IF A STUDENT FAILS TO BE PRESENT ON THE DAY OF ASSESSMENT THEN THAT SUBJECT WILL BE MARKED AS 'NO RESULT' IN THE STATEMENT OF RESULT.",
];

const TITLE = 'NOTICE TO CANDIDATES';

export const JUNIOR_NOTICE: Notice = {
    style: 'bullets',
    title: TITLE,
    subtitle: 'KNOW THE RULES BEFORE YOU TAKE YOUR ASSESSMENT.',
    items: [REVIEW, RESOURCES, ...SHARED_TAIL].map(plain),
};

export const SENIOR_NOTICE: Notice = {
    style: 'bullets',
    title: TITLE,
    subtitle: 'KNOW THE RULES BEFORE YOU TAKE YOUR ASSESSMENT.',
    items: [
        REVIEW,
        'ONLY SIMPLE CALCULATORS ARE ALLOWED IN MATHEMATICS P-II AND PHYSICS.',
        'OVERWRITING IS STRICTLY PROHIBITED.',
        'THE USE OF WHITEOUT OR CORRECTION FLUID IS NOT ALLOWED.',
        'ENSURE THE MCQ GRID IS FILLED OUT CORRECTLY; FAILURE TO FOLLOW THIS RULE MAY RESULT IN MARK DEDUCTIONS.',
        RESOURCES,
        ...SHARED_TAIL,
    ].map(plain),
};

export const CAMBRIDGE_NOTICE: Notice = {
    style: 'cambridge',
    title: TITLE,
    subtitle: 'KNOW THE RULES BEFORE YOU TAKE YOUR ASSESSMENTS.',
    items: [
        rich('You ', ['must'], ' be on time for all your assessments and any required periods of supervision.'),
        rich('You ', ['must'], ' provide what you need e.g. pens, pencils and rulers.'),
        rich('You ', ['may'], ' use a calculator unless you are told not to do so, but you ', ['must not'], ' use a graphical calculator or the calculator function of another device.'),
        rich('You ', ['must not'], ' become involved in any unfair or dishonest practice before, during or after the assessments.'),
        {
            ...rich('You ', ['must not:']),
            sub: [
                'Sit an examination in the name of another candidate;',
                'Have in your possession any unauthorised material, including electronic devices and mobile phones.',
                'Have in your possession any equipment which might give you an unfair advantage.',
            ],
        },
        rich('Possession of unauthorised material is breaking the rules, even if you do not intend to use it. If found in possession of unauthorised material you will be subject to penalty and possible disqualification.'),
        rich('You ', ['must not'], ' talk to, attempt to communicate with or disturb other candidates once you have entered the examination room.'),
        rich('You ', ['must'], ' follow the instructions of the invigilator.'),
        rich('If you are in any doubt speak to the invigilator.'),
        rich('You ', ['must'], ' when leaving the examination room leave behind the question paper, your answer book or answer paper, rough work and any other (used or unused) materials.'),
    ],
};

const SENIOR = new Set<number>([CLASS_IDS.SR_I, CLASS_IDS.SR_II, CLASS_IDS.SR_III]);
const CAMBRIDGE = new Set<number>([CLASS_IDS.O_I, CLASS_IDS.O_II, CLASS_IDS.O_III, CLASS_IDS.AS, CLASS_IDS.A2]);

/** The notice on the back of a statement of entry for this class. Junior covers Pre-Nursery to Jr. V. */
export function noticeForClass(classId: number): Notice {
    if (CAMBRIDGE.has(classId)) return CAMBRIDGE_NOTICE;
    if (SENIOR.has(classId)) return SENIOR_NOTICE;
    return JUNIOR_NOTICE;
}

export const noticeItemText = (i: NoticeItem) => i.parts.map((p) => p.text).join('');

/**
 * TAFSD-528: which of the schedule's notes go on a statement of entry's back page.
 * The schedule's notes are written for the schedule sheet and repeat most of the
 * notice, so the back page keeps to the school's notice sheets: for Junior and
 * Senior, only the results / PTM line as the last bullet; the Cambridge notice
 * (O and A Level) stands on its own.
 */
export function backPageNotes(notice: Notice, notes: string[]): string[] {
    if (notice.style === 'cambridge') return [];
    const results = notes.find((n) => /\bRESULTS?\b[^.]*\b(DISTRIBUTED|ANNOUNCED)\b/i.test(n));
    return results ? [results] : [];
}

/**
 * TAFSD-528: the notice for this class with the schedule's title filled in, so a
 * line reads "... APPEAR IN THE FIRST SEMESTER ASSESSMENTS." as on the school's
 * sheets (Junior / Senior / O and A Level, shared in the group).
 */
export function noticeForSchedule(classId: number, assessment: string): Notice {
    const base = noticeForClass(classId);
    const title = assessment.trim().toUpperCase() || 'ASSESSMENTS';
    const fill = (t: string) => t.split(ASSESSMENT).join(title);
    return {
        ...base,
        items: base.items.map((it) => ({ ...it, parts: it.parts.map((p) => ({ ...p, text: fill(p.text) })), sub: it.sub?.map(fill) })),
    };
}
