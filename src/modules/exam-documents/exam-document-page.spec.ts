import { buildExamDocPage, ExamDocPageInput, longDate } from './exam-document-page';
import { fitAdmit, fitOneLine, fitTable, frontNotes, pageCountLabel, rowPadding, subjectLines } from './ExamDocumentPDF';

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
            { day: 'TUESDAY', date: 'DECEMBER 22, 2026', dayDate: 'TUESDAY, DECEMBER 22, 2026', time: '8:00 – 11:30', subject: 'History', code: null },
        ]);
    });

    it('keeps the level out of a statement of entry heading: it has its own box beside the centre number', () => {
        const d = buildExamDocPage(base());
        expect(d.docType).toBe('STATEMENT_OF_ENTRY');
        expect(d.lines).toEqual(['FIRST SEMESTER ASSESSMENTS', 'SENIOR CAMBRIDGE', 'SESSION : 2026 – 2027']);
        expect([d.className, d.sectionName]).toEqual(['Sr. I', 'A']);
        expect(d.campusLine).toBe('CAMPUS # II : SENIOR CAMBRIDGE SEGMENT');
        // CENTRE / CANDIDATE # : PK 564 / 4137 — the candidate number is the C.C.
        expect([d.centre, d.cc]).toEqual(['PK 564', '4137']);
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

    it('writes the date of birth with dashes and the admit card\'s day & date in full capitals', () => {
        const d = buildExamDocPage(base({ classId: 15, className: 'VI', schedule: { ...base().schedule, papers: [
            { class_id: 15, paper_date: new Date('2026-09-28T00:00:00Z'), time_text: '8:00 – 11:30', subject: 'Science', code: null },
        ] } }));
        expect(d.dob).toBe('22-05-2014');
        expect(d.papers[0].dayDate).toBe('MONDAY, SEPTEMBER 28, 2026');
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
        expect(rowPadding(Array<number>(8).fill(1))).toBe(6.5);
        const tenWrapped = rowPadding([2, 1, 2, 1, 1, 1, 1, 2, 1, 1]);
        expect(tenWrapped).toBeLessThan(rowPadding(Array<number>(10).fill(1)));
        expect(rowPadding(Array<number>(30).fill(2))).toBe(1.5);
    });

    it('shrinks the table text only once the rows are at their tightest', () => {
        expect(fitTable(Array<number>(10).fill(1), 226)).toEqual({ pv: 5.5, size: 10 });
        const crowded = fitTable(Array<number>(16).fill(2), 226);
        expect(crowded.pv).toBe(1.5);
        expect(crowded.size).toBeLessThan(10);
        expect(crowded.size).toBeGreaterThanOrEqual(6.5);
    });

    it('fits an admit card with the school\'s IX schedule at full table size', () => {
        const fit = fitAdmit(Array<number>(10).fill(1), Array<string>(9).fill('NO PRE OR POST ASSESSMENT WILL BE CONDUCTED, AND THE RESULT WILL BE ANNOUNCED IN THE PTM.'));
        expect(fit.size).toBe(10);
        expect(fit.noteSize).toBeGreaterThanOrEqual(8);
    });

    it('fills the admit card GROUP: SCIENCE for VI–VIII, the directory discipline for IX–X', () => {
        const at = (classId: number, discipline: string | null) =>
            buildExamDocPage(base({ classId, className: 'X', student: { ...base().student, discipline } })).group;
        expect(at(15, null)).toBe('SCIENCE');
        expect(at(17, 'Pre-Medical')).toBe('SCIENCE');
        expect(at(18, 'Computer')).toBe('COMPUTER');
        expect(at(19, ' biology ')).toBe('BIOLOGY');
        expect(at(18, null)).toBe('');
        // A statement of entry has no GROUP box.
        expect(at(9, 'Computer')).toBe('');
    });

    it('fills the schedule title into the notice, as on the school\'s sheets', () => {
        const d = buildExamDocPage(base({ classId: 4, className: 'Jr. I' }));
        expect(d.notice!.items.map((i) => i.parts.map((p) => p.text).join(''))).toContain(
            'IN FAILURE TO BRING STATEMENT OF ENTRY, NO STUDENT WILL BE ALLOWED TO APPEAR IN THE FIRST SEMESTER ASSESSMENTS.',
        );
    });

    it('prints the campus address and UAN from the campus record', () => {
        const d = buildExamDocPage(base({ schedule: { ...base().schedule, campusAddress: ' C-61, Block 13 ', campusUan: ' 111-823-723 ' } }));
        expect([d.campusAddress, d.campusUan]).toEqual(['C-61, BLOCK 13', '111-823-723']);
        const none = buildExamDocPage(base({ schedule: { ...base().schedule, campusAddress: null, campusUan: '' } }));
        expect([none.campusAddress, none.campusUan]).toEqual([null, null]);
    });

        it('keeps a long name on one line of its box', () => {
        expect(fitOneLine('HAMZA ARIF', 270)).toBe(10.5);
        const long = fitOneLine('MUHAMMAD ABDUL REHMAN SIDDIQUI QURESHI KHAN YOUSUFZAI', 270);
        expect(long).toBeLessThan(10.5);
        expect(long).toBeGreaterThanOrEqual(7);
    });
});
