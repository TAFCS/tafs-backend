/**
 * TAFSD-510: the school's five December 2026 schedules (Campus II, Gulistan-e-Jauhar),
 * transcribed from the Word / Excel files the school circulated on 24–29 Oct 2026:
 *   SCHEDULE OF FIRST SEMESTER JRS.doc           -> Jr I – Jr V
 *   FIRST SEMESTER SCHEDULE SR.I - SR.III.doc     -> Sr I – Sr III
 *   PRE-MOCKS & FIRST SEMESTER (1).xls            -> O-I – O-III ("FOR STUDENTS (2)" sheet)
 *   SCHEDULE OF FINAL MID TERM EXAMINATION DONE.xls -> VI – VIII (stale 2016 rows ignored)
 *   SCHEDULE OF PRELIMINARY.xls                   -> IX – X
 * Subjects are as the school printed them. Only typos are fixed ("TUESSDAY").
 */

export interface SeedSchedule {
    key: string;
    campus_id: number;
    academic_year: string;
    title: string;
    segment_line: string;
    reference_no: string;
    dues_cleared_through: string;
    issue_from: string;
    /** class_id -> [date, subject][] ; '-' cells are left out. */
    grid: Record<number, [string, string][]>;
    time_text: string;
    notes: string[];
}

const GEJ = 1;
const YEAR = '2026-2027';
const TIME = '8:00 – 11:30';
const DUES = '2026-12-31';
const ISSUE = '2026-12-09';

const C = { JR_I: 4, JR_II: 5, JR_III: 6, JR_IV: 7, JR_V: 8, SR_I: 9, SR_II: 10, SR_III: 11, O_I: 12, O_II: 13, O_III: 14, VI: 15, VII: 16, VIII: 17, IX: 18, X: 19 };

const COMMON_RULES = {
    closure: "IN CASE OF SCHOOL'S CLOSURE DUE TO ANY REASON, THE ASSESSMENT OF THAT DAY WILL BE ASSESSED AFTER THE LAST SCHEDULED ASSESSMENT.",
    noPrePost: 'NO PRE OR POST ASSESSMENT WILL BE CONDUCTED.',
    review: 'KINDLY REVIEW THE WORK DONE WITH YOUR CHILD SO THAT HE / SHE MAY ACHIEVE THE BEST GRADES.',
    pouches: 'NO LENDING OR BORROWING WILL BE ALLOWED, STUDENTS HAVE TO BRING TRANSPARENT POUCHES FOR THEIR STATIONERY.',
    bags: 'NO BAGS AND NOTEBOOKS ARE ALLOWED DURING THE ASSESSMENTS.',
    board: 'USAGE OF ASSESSMENT BOARD IS NOT ALLOWED.',
};

export const DEC_2026_SCHEDULES: SeedSchedule[] = [
    {
        key: 'jr',
        campus_id: GEJ,
        academic_year: YEAR,
        title: 'FIRST SEMESTER ASSESSMENTS',
        segment_line: 'JUNIOR CAMBRIDGE',
        reference_no: 'TAFSAL-0001/214465-234494/10/26',
        dues_cleared_through: DUES,
        issue_from: ISSUE,
        time_text: TIME,
        grid: {
            [C.JR_I]: [
                ['2026-12-11', 'ENGLISH COMPOSITIONS'],
                ['2026-12-12', 'COMPUTER PRACTICAL & URDU LITERATURE'],
                ['2026-12-14', 'ENGLISH & URDU COMPREHENSION'],
                ['2026-12-15', 'URDU COMPOSITIONS'],
                ['2026-12-16', 'MATHEMATICS'],
                ['2026-12-17', 'ENGLISH GRAMMAR & ENGLISH LITERATURE'],
                ['2026-12-18', 'URDU GRAMMAR'],
                ['2026-12-19', 'COMPUTER SCIENCE'],
                ['2026-12-21', 'SCIENCE'],
            ],
            [C.JR_II]: [
                ['2026-12-11', 'ENGLISH COMPOSITIONS'],
                ['2026-12-12', 'ENGLISH & URDU COMPREHENSION'],
                ['2026-12-14', 'COMPUTER PRACTICAL & URDU LITERATURE'],
                ['2026-12-15', 'URDU COMPOSITIONS'],
                ['2026-12-16', 'MATHEMATICS'],
                ['2026-12-17', 'ENGLISH GRAMMAR & ENGLISH LITERATURE'],
                ['2026-12-18', 'URDU GRAMMAR'],
                ['2026-12-19', 'COMPUTER SCIENCE'],
                ['2026-12-21', 'SCIENCE'],
            ],
            [C.JR_III]: [
                ['2026-12-11', 'ENGLISH APPLICATION WRITING'],
                ['2026-12-12', 'ENGLISH & URDU COMPREHENSION'],
                ['2026-12-14', 'URDU APPLICATION WRITING'],
                ['2026-12-15', 'ENGLISH GRAMMAR & ENGLISH LITERATURE'],
                ['2026-12-16', 'MATHEMATICS'],
                ['2026-12-17', 'SCIENCE'],
                ['2026-12-18', 'URDU GRAMMAR'],
                ['2026-12-19', 'COMPUTER PRACTICAL & URDU LITERATURE'],
                ['2026-12-21', 'COMPUTER SCIENCE'],
            ],
            [C.JR_IV]: [
                ['2026-12-11', 'ENGLISH APPLICATION WRITING'],
                ['2026-12-12', 'ENGLISH & URDU COMPREHENSION'],
                ['2026-12-14', 'URDU APPLICATION WRITING'],
                ['2026-12-15', 'COMPUTER PRACTICAL & URDU LITERATURE'],
                ['2026-12-16', 'SCIENCE'],
                ['2026-12-17', 'COMPUTER SCIENCE'],
                ['2026-12-18', 'URDU GRAMMAR'],
                ['2026-12-19', 'ENGLISH GRAMMAR & ENGLISH LITERATURE'],
                ['2026-12-21', 'MATHEMATICS'],
            ],
            [C.JR_V]: [
                ['2026-12-11', 'ENGLISH LETTER WRITING (INFORMAL)'],
                ['2026-12-12', 'ENGLISH & URDU COMPREHENSION'],
                ['2026-12-14', 'URDU LETTER WRITING (INFORMAL)'],
                ['2026-12-15', 'COMPUTER SCIENCE'],
                ['2026-12-16', 'COMPUTER PRACTICAL & URDU LITERATURE'],
                ['2026-12-17', 'MATHEMATICS'],
                ['2026-12-18', 'URDU GRAMMAR'],
                ['2026-12-19', 'SCIENCE'],
                ['2026-12-21', 'ENGLISH GRAMMAR & ENGLISH LITERATURE'],
            ],
        },
        notes: [
            'IN FAILURE TO BRING STATEMENT OF ENTRY, STUDENT WILL NOT BE ALLOWED TO APPEAR IN THE FIRST SEMESTER ASSESSMENTS.',
            "IN CASE OF SCHOOL'S CLOSURE DUE TO ANY CITY DISTURBANCE, ASSESSMENT OF THAT DAY WILL BE ASSESSED AFTER THE LAST SCHEDULED ASSESSMENT.",
            'NO PRE OR POST ASSESSMENT WILL BE HELD.',
            "IF A STUDENT FAILS TO BE PRESENT ON THE DAY OF ASSESSMENT THEN THAT SUBJECT WILL BE MARKED AS 'NO RESULT' IN THE STATEMENT OF RESULT.",
            COMMON_RULES.review,
            'RESOURCE MATERIALS : LECTURES, TEXT BOOKS, REFERENCE BOOKS, REGISTERS / NOTE BOOKS & DLCB PORTAL.',
            COMMON_RULES.pouches,
            COMMON_RULES.bags,
            'USING ASSESSMENT BOARD IS NOT ALLOWED.',
            'THE RESULTS WILL BE DISTRIBUTED IN THE PTM SCHEDULED ON SATURDAY, JANUARY 16, 2027 AT CAMPUS – III IN SHA ALLAH.',
        ],
    },
    {
        key: 'sr',
        campus_id: GEJ,
        academic_year: YEAR,
        title: 'FIRST SEMESTER ASSESSMENTS',
        segment_line: 'SENIOR CAMBRIDGE',
        reference_no: 'TAFSAL-0001/214465-234494/10/26',
        dues_cleared_through: DUES,
        issue_from: ISSUE,
        time_text: TIME,
        grid: {
            [C.SR_I]: [
                ['2026-12-11', 'CHEMISTRY'], ['2026-12-12', 'GEOGRAPHY'], ['2026-12-14', 'MATHEMATICS'], ['2026-12-15', 'URDU'],
                ['2026-12-16', 'PHYSICS'], ['2026-12-17', 'ENGLISH'], ['2026-12-18', 'COMPUTER'], ['2026-12-19', 'BIOLOGY'],
                ['2026-12-21', 'ISLAMIYAT'], ['2026-12-22', 'HISTORY'],
            ],
            [C.SR_II]: [
                ['2026-12-11', 'GEOGRAPHY'], ['2026-12-12', 'URDU'], ['2026-12-14', 'MATHEMATICS'], ['2026-12-15', 'ISLAMIYAT'],
                ['2026-12-16', 'ENGLISH'], ['2026-12-17', 'BIOLOGY'], ['2026-12-18', 'CHEMISTRY'], ['2026-12-19', 'COMPUTER'],
                ['2026-12-21', 'HISTORY'], ['2026-12-22', 'PHYSICS'],
            ],
            [C.SR_III]: [
                ['2026-12-11', 'ENGLISH'], ['2026-12-12', 'BIOLOGY'], ['2026-12-14', 'MATHEMATICS'], ['2026-12-15', 'URDU'],
                ['2026-12-16', 'COMPUTER'], ['2026-12-17', 'GEOGRAPHY'], ['2026-12-18', 'ISLAMIYAT'], ['2026-12-19', 'PHYSICS'],
                ['2026-12-21', 'HISTORY'], ['2026-12-22', 'CHEMISTRY'],
            ],
        },
        notes: [
            'IN FAILURE TO BRING STATEMENT OF ENTRY, NO STUDENT WILL BE ALLOWED TO APPEAR IN THE FIRST SEMESTER ASSESSMENTS.',
            COMMON_RULES.closure,
            COMMON_RULES.noPrePost,
            COMMON_RULES.review,
            'RESOURCE MATERIALS : LECTURES, TEXT BOOKS, REFERENCE BOOKS, REGISTERS / NOTE BOOKS.',
            COMMON_RULES.pouches,
            COMMON_RULES.bags,
            COMMON_RULES.board,
            'THE RESULTS WILL BE DISTRIBUTED FOR THE STUDENTS OF SR.I TO SR.III IN THE PTM SCHEDULED ON SATURDAY, JANUARY 16, 2027. IN SHA ALLAH.',
        ],
    },
    {
        key: 'o',
        campus_id: GEJ,
        academic_year: YEAR,
        title: 'PRE-MOCK & FIRST SEMESTER ASSESSMENTS',
        segment_line: 'O LEVELS',
        reference_no: 'TAFSAL-0001/214465-234494/10/26',
        dues_cleared_through: DUES,
        issue_from: ISSUE,
        time_text: TIME,
        grid: {
            [C.O_I]: [
                ['2026-12-11', 'URDU'], ['2026-12-12', 'ENGLISH'], ['2026-12-14', 'PAKISTAN STUDIES P1'], ['2026-12-15', 'CHEMISTRY / B. STUDIES'],
                ['2026-12-16', 'PAKISTAN STUDIES P2'], ['2026-12-17', 'MATHEMATICS'], ['2026-12-18', 'COMP. SCIENCE / BIO. / ACCOUNTING'],
                ['2026-12-19', 'ISLAMIYAT'], ['2026-12-21', 'ECONOMICS / PHYSICS'],
            ],
            [C.O_II]: [
                ['2026-12-11', 'URDU'], ['2026-12-12', 'ENGLISH'], ['2026-12-14', 'PAKISTAN STUDIES P1'], ['2026-12-15', 'ISLAMIYAT P1'],
                ['2026-12-16', 'ISLAMIYAT P2'], ['2026-12-17', 'PAKISTAN STUDIES P2'], ['2026-12-18', 'CHEMISTRY / B. STUDIES'],
                ['2026-12-19', 'COMP. SCIENCE / BIO. / ACCOUNTING'], ['2026-12-21', 'ECONOMICS / PHYSICS'], ['2026-12-22', 'MATHEMATICS'],
            ],
            [C.O_III]: [
                ['2026-12-11', 'ECONOMICS P2 / CHEMISTRY P1, P4'], ['2026-12-12', 'ACCOUNTING P2 / CHEMISTRY P2'],
                ['2026-12-14', 'B. STUDIES P1 / BIO. P1, P6 / COMPUTER SCIENCE P1'], ['2026-12-15', 'ACCOUNTING P1 / PHYSICS P1, P4'],
                ['2026-12-16', 'ECONOMICS P1 / PHYSICS P2'], ['2026-12-17', 'MATHEMATICS P1'], ['2026-12-18', 'ENGLISH P1'],
                ['2026-12-19', 'B. STUDIES P2 / BIO P2 / COMPUTER SCIENCE P2'], ['2026-12-21', 'MATHEMATICS P2'], ['2026-12-22', 'ENGLISH P2'],
            ],
        },
        notes: [
            'IN FAILURE TO BRING STATEMENT OF ENTRY, NO STUDENT WILL BE ALLOWED TO APPEAR IN THE FIRST SEMESTER ASSESSMENTS.',
            COMMON_RULES.closure,
            COMMON_RULES.noPrePost,
            "IF A STUDENT FAILS TO BE PRESENT ON THE DAY OF ASSESSMENT THEN THAT SUBJECT WILL BE MARKED AS 'NO RESULT' IN THE STATEMENT OF RESULT.",
            COMMON_RULES.review,
            'RESOURCE MATERIALS : LECTURES, TEXT BOOKS, REFERENCE BOOKS, REGISTERS / NOTE BOOKS AND DLCB PORTAL.',
            COMMON_RULES.pouches,
            COMMON_RULES.bags,
            COMMON_RULES.board,
            'THE RESULTS WILL BE DISTRIBUTED FOR THE STUDENTS OF O-I - O-III IN THE PTM SCHEDULED ON SATURDAY, JANUARY 16, 2027. IN SHA ALLAH.',
        ],
    },
    {
        key: 'vi-viii',
        campus_id: GEJ,
        academic_year: YEAR,
        title: 'FINAL MIDTERM ASSESSMENTS',
        segment_line: 'SECONDARY SEGMENT',
        reference_no: 'TAFSS-0001/214346-243295/10/26',
        dues_cleared_through: DUES,
        issue_from: ISSUE,
        time_text: TIME,
        grid: {
            [C.VI]: [
                ['2026-12-11', 'MATHEMATICS'], ['2026-12-14', 'ENGLISH'], ['2026-12-15', 'ISLAMIAT'], ['2026-12-16', 'SOCIAL STUDIES'],
                ['2026-12-17', 'COMPUTER'], ['2026-12-18', 'URDU'], ['2026-12-21', 'SINDHI'], ['2026-12-22', 'SCIENCE'],
            ],
            [C.VII]: [
                ['2026-12-11', 'MATHEMATICS'], ['2026-12-14', 'SCIENCE'], ['2026-12-15', 'ISLAMIAT'], ['2026-12-16', 'SINDHI'],
                ['2026-12-17', 'SOCIAL STUDIES'], ['2026-12-18', 'COMPUTER'], ['2026-12-21', 'URDU'], ['2026-12-22', 'ENGLISH'],
            ],
            [C.VIII]: [
                ['2026-12-11', 'MATHEMATICS'], ['2026-12-14', 'ENGLISH'], ['2026-12-15', 'ISLAMIAT'], ['2026-12-16', 'PAKISTAN STUDIES'],
                ['2026-12-17', 'URDU'], ['2026-12-18', 'SCIENCE'], ['2026-12-21', 'COMPUTER'], ['2026-12-22', 'SINDHI'],
            ],
        },
        notes: [
            COMMON_RULES.review,
            'RESOURCE MATERIALS: LECTURES, TEXT BOOKS, REFERENCE BOOKS, NOTEBOOKS / JOURNALS / REGISTERS.',
            "IN CASE OF SCHOOL'S CLOSURE DUE TO ANY CITY DISTURBANCE, THE ASSESSMENT OF THAT DAY WILL BE ASSESSED AFTER THE LAST SCHEDULED ASSESSMENT.",
            COMMON_RULES.noPrePost,
            'THE RESULT WILL BE ANNOUNCED ON FRIDAY, JANUARY 15, 2027 IN SHA ALLAH.',
        ],
    },
    {
        key: 'ix-x',
        campus_id: GEJ,
        academic_year: YEAR,
        title: 'PRELIMINARY ASSESSMENTS',
        segment_line: 'CLASSES IX & X',
        reference_no: 'TAFSS-0001/214561-2349/10/26',
        dues_cleared_through: DUES,
        issue_from: ISSUE,
        time_text: TIME,
        grid: {
            [C.IX]: [
                ['2026-12-11', 'PHYSICS PRACTICAL'], ['2026-12-12', 'CHEMISTRY PRACTICAL'], ['2026-12-14', 'BIOLOGY / COMPUTER PRACTICAL'],
                ['2026-12-15', 'PHYSICS THEORY'], ['2026-12-16', 'ISLAMIAT'], ['2026-12-17', 'MATHEMATICS'], ['2026-12-18', 'URDU'],
                ['2026-12-19', 'CHEMISTRY THEORY'], ['2026-12-21', 'ENGLISH'], ['2026-12-22', 'BIOLOGY / COMPUTER THEORY'],
            ],
            [C.X]: [
                ['2026-12-11', 'CHEMISTRY PRACTICAL'], ['2026-12-12', 'PHYSICS PRACTICAL'], ['2026-12-14', 'BIOLOGY / COMPUTER PRACTICAL'],
                ['2026-12-15', 'BIOLOGY / COMPUTER THEORY'], ['2026-12-16', 'ENGLISH'], ['2026-12-17', 'MATHEMATICS'], ['2026-12-18', 'CHEMISTRY THEORY'],
                ['2026-12-19', 'SINDHI'], ['2026-12-21', 'PAKISTAN STUDIES'], ['2026-12-22', 'PHYSICS THEORY'],
            ],
        },
        notes: [
            'IN FAILURE TO BRING ADMIT CARD, NO STUDENT WILL BE ALLOWED TO APPEAR IN THE PRELIMINARY ASSESSMENTS.',
            "IN CASE OF SCHOOL'S CLOSURE DUE TO ANY CITY DISTURBANCE, THE ASSESSMENT OF THAT DAY WILL BE ASSESSED AFTER THE LAST SCHEDULED ASSESSMENT.",
            COMMON_RULES.noPrePost,
            'KINDLY REVIEW THE WORK DONE WITH YOUR CHILD SO THAT HE / SHE MAY ACHIEVE THE BEST GRADE.',
            'RESOURCE MATERIALS : LECTURES, TEXT BOOKS, REFERENCE BOOKS, REGISTERS / NOTE BOOKS.',
            COMMON_RULES.pouches,
            'NO BAGS AND NOTEBOOKS ARE ALLOWED DURING THE ASSESSMENTS IN THE CAMPUS.',
            COMMON_RULES.board,
            'THE RESULT WILL BE ANNOUNCED ON SATURDAY, JANUARY 15, 2027, IN SHA ALLAH.',
        ],
    },
];

/** The schedule as the API's upsert body. */
export function toUpsertBody(s: SeedSchedule) {
    const classIds = Object.keys(s.grid).map(Number);
    return {
        campus_id: s.campus_id,
        academic_year: s.academic_year,
        title: s.title,
        segment_line: s.segment_line,
        reference_no: s.reference_no,
        dues_cleared_through: s.dues_cleared_through,
        issue_from: s.issue_from,
        notes: s.notes,
        class_ids: classIds,
        papers: classIds.flatMap((class_id) =>
            s.grid[class_id].map(([paper_date, subject]) => ({ class_id, paper_date, time_text: s.time_text, subject })),
        ),
    };
}
