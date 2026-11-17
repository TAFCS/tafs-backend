import { buildExamDocPage, ExamDocPageInput, longDate } from './exam-document-page';
import { frontNotes, pageCountLabel, rowPadding, subjectLines } from './ExamDocumentPDF';

const base = (over: Partial<ExamDocPageInput> = {}): ExamDocPageInput => ({
    schedule: {
        title: 'First Semester Assessments',
        segmentLine: 'Senior Cambridge',
        academicYear: '2026-2027',
        notes: ['NO PRE OR POST ASSESSMENT WILL BE CONDUCTED.'],
        campusName: 'Campus # II',
        campusAddress: null,
        papers: [
            { class_id: 9, paper_date: new Date('2026-12-22T00:00:00Z'), time_text: '8:00 – 11:30', subject: 'History', code: null },
            { class_id: 10, paper_date: new Date('2026-12-11T00:00:00Z'), time_text: '8:00 – 11:30', subject: 'Urdu', code: null },
        ],
    },
    classId: 9,
    className: 'Sr. I',
    sectionName: 'A',
    serialNo: 7,
    issuedAt: new Date('2026-12-09T05:00:00Z'),
    student: { cc: 4137, gr: '6120', fullName: 'Hamza Arif', father: 'Arif Siddiqui', dob: new Date('2014-05-22'), gender: 'Male' },
    photo: null,
    ...over,
});

describe('TAFSD-528 exam document page', () => {
    it('writes assessment dates as "December 22, 2026"', () => {
        expect(longDate('2026-12-22')).toBe('December 22, 2026');
        expect(longDate('2027-01-05T00:00:00.000Z')).toBe('January 5, 2027');
        const d = buildExamDocPage(base());
        expect(d.papers).toEqual([
            { day: 'TUESDAY', date: 'December 22, 2026', dayDate: 'Tuesday, 22-12-2026', time: '8:00 – 11:30', subject: 'History', code: null },
        ]);
    });

    it('heads a statement of entry with the level, as on the Sr I sheet', () => {
        const d = buildExamDocPage(base());
        expect(d.docType).toBe('STATEMENT_OF_ENTRY');
        expect(d.lines).toEqual(['FIRST SEMESTER ASSESSMENTS', 'SENIOR CAMBRIDGE', 'SESSION : 2026 – 2027', 'LEVEL SR. I A']);
        expect(d.campusLine).toBe('CAMPUS # II : SENIOR CAMBRIDGE SEGMENT');
    });

    it('gives VI–X an admit card with the class in its own box, not in the heading', () => {
        const d = buildExamDocPage(base({ classId: 15, className: 'VI', schedule: { ...base().schedule, segmentLine: null } }));
        expect(d.docType).toBe('ADMIT_CARD');
        expect(d.title).toBe('ADMIT CARD');
        expect(d.lines).toEqual(['FIRST SEMESTER ASSESSMENTS', 'SESSION : 2026 – 2027']);
        expect(d.campusLine).toBe('CAMPUS # II : SECONDARY SEGMENT');
    });

    it('keeps the schedule line ("CLASSES IX & X") out of the admit card heading: the class has its own box', () => {
        for (const line of ['CLASSES IX & X', 'SECONDARY SEGMENT']) {
            const d = buildExamDocPage(base({ classId: 18, className: 'IX', schedule: { ...base().schedule, segmentLine: line } }));
            expect(d.lines).toEqual(['FIRST SEMESTER ASSESSMENTS', 'SESSION : 2026 – 2027']);
            expect(d.campusLine).toBe('CAMPUS # II : SECONDARY SEGMENT');
        }
    });

    it('writes every date with dashes: date of birth and the admit card\'s day & date', () => {
        const d = buildExamDocPage(base({ classId: 15, className: 'VI', schedule: { ...base().schedule, papers: [
            { class_id: 15, paper_date: new Date('2026-09-28T00:00:00Z'), time_text: '8:00 – 11:30', subject: 'Science', code: null },
        ] } }));
        expect(d.dob).toBe('22-05-2014');
        expect(d.papers[0].dayDate).toBe('Monday, 28-09-2026');
    });

    it('leaves missing G.R., father and date of birth empty for the PDF to dash', () => {
        const d = buildExamDocPage(base({ student: { cc: 7412, gr: null, fullName: 'Ayesha Kamran', father: '', dob: null, gender: null } }));
        expect([d.gr, d.father, d.dob, d.gender]).toEqual(['', '', '', null]);
        expect(d.initials).toBe('AK');
    });

    it('numbers pages "PAGE # 01 OF 02"', () => {
        expect(pageCountLabel(1, 2)).toBe('PAGE # 01 OF 02');
        expect(pageCountLabel(1, 1)).toBe('PAGE # 01 OF 01');
    });

    it('names the right document in the front-page lines', () => {
        expect(frontNotes({ docType: 'ADMIT_CARD' })[1]).toBe('BRING THIS ADMIT CARD EVERY DAY UNTIL THE LAST DAY OF THE ASSESSMENTS.');
        expect(frontNotes({ docType: 'STATEMENT_OF_ENTRY' })[1]).toContain('STATEMENT OF ENTRY');
    });

    it('keeps the Sr I row spacing for ten one-line papers and tightens for wrapped ones', () => {
        expect(subjectLines('ACCOUNTING P2 / CHEMISTRY P2', 29)).toBe(1);
        expect(subjectLines('ECONOMICS P2 / CHEMISTRY P1, P4', 29)).toBe(2);
        expect(subjectLines('B. STUDIES P1 / BIO. P1, P6 / COMPUTER SCIENCE P1', 29)).toBe(2);
        expect(rowPadding(Array(8).fill(1))).toBe(6.5);
        const tenWrapped = rowPadding([2, 1, 2, 1, 1, 1, 1, 2, 1, 1]);
        expect(tenWrapped).toBeLessThan(rowPadding(Array(10).fill(1)));
        expect(rowPadding(Array(30).fill(2))).toBe(1.5);
    });
});
