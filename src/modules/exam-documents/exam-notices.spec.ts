import { CAMBRIDGE_NOTICE, JUNIOR_NOTICE, SENIOR_NOTICE, noticeForClass, noticeItemText, backPageNotes } from './exam-notices';
import { noticeLayout } from './ExamDocumentPDF';
import { buildExamDocPage } from './exam-document-page';
import { DEC_2026_SCHEDULES } from '../../../scripts/data/exam-schedules-dec-2026';

describe('TAFSD-528 notice to candidates', () => {
    it('picks the notice by segment', () => {
        for (const id of [1, 3, 4, 8]) expect(noticeForClass(id)).toBe(JUNIOR_NOTICE);
        for (const id of [9, 10, 11]) expect(noticeForClass(id)).toBe(SENIOR_NOTICE);
        for (const id of [12, 13, 14, 20, 21]) expect(noticeForClass(id)).toBe(CAMBRIDGE_NOTICE);
    });

    it('keeps sitting-specific lines out of the standing notices', () => {
        for (const n of [JUNIOR_NOTICE, SENIOR_NOTICE, CAMBRIDGE_NOTICE]) {
            const text = n.items.map(noticeItemText).join(' ');
            expect(text).not.toMatch(/\b20\d\d\b/);
            expect(text).not.toMatch(/PTM|FIRST SEMESTER/i);
        }
        expect(SENIOR_NOTICE.items.map(noticeItemText)).toContain('OVERWRITING IS STRICTLY PROHIBITED.');
        expect(CAMBRIDGE_NOTICE.items).toHaveLength(10);
        expect(CAMBRIDGE_NOTICE.items[4].sub).toHaveLength(3);
    });

    it('puts a notice on every statement of entry and none on an admit card', () => {
        const input = (classId: number) => ({
            schedule: { title: 'Final', segmentLine: null, academicYear: '2026-2027', notes: [], campusName: 'C', campusAddress: null, papers: [] },
            classId,
            className: 'X',
            sectionName: null,
            serialNo: 1,
            issuedAt: new Date('2026-12-09T05:00:00Z'),
            student: { cc: 1, gr: null, fullName: 'A B', father: '', dob: null, gender: null },
            photo: null,
        });
        const senior = buildExamDocPage(input(9)).notice!;
        expect([senior.style, senior.title, senior.items.length]).toEqual([SENIOR_NOTICE.style, SENIOR_NOTICE.title, SENIOR_NOTICE.items.length]);
        expect(buildExamDocPage(input(9)).assessment).toBe('FINAL');
        expect(buildExamDocPage(input(15)).notice).toBeNull();
    });

    it('keeps the back page to the school sheets: the results line for Junior / Senior, nothing for Cambridge', () => {
        const presetNotes = [
            'STATEMENTS OF ENTRY WILL BE ISSUED ON WEDNESDAY, DECEMBER 09, 2026, SUBJECT TO THE CLEARANCE OF DUES TILL DECEMBER 2026.',
            'NO PRE OR POST ASSESSMENT WILL BE CONDUCTED.',
            'THE RESULTS WILL BE DISTRIBUTED FOR THE STUDENTS OF SR.I TO SR.III IN THE PTM SCHEDULED ON SATURDAY, JANUARY 16, 2027. IN SHA ALLAH.',
            'KINDLY CLEAR THE OUTSTANDING DUES TILL DECEMBER 2026 ON OR BEFORE, TUESDAY, DECEMBER 08, 2026 IF THERE ARE ANY.',
        ];
        expect(backPageNotes(SENIOR_NOTICE, presetNotes)).toEqual([presetNotes[2]]);
        expect(backPageNotes(JUNIOR_NOTICE, ['THE RESULT WILL BE ANNOUNCED ON FRIDAY, JANUARY 15, 2027 IN SHA ALLAH.'])).toHaveLength(1);
        expect(backPageNotes(CAMBRIDGE_NOTICE, presetNotes)).toEqual([]);
        expect(backPageNotes(SENIOR_NOTICE, [])).toEqual([]);
    });

    it('fits each back page on one page: Cambridge with its sign, Senior with its PTM line', () => {
        expect(noticeLayout(CAMBRIDGE_NOTICE, [])).toEqual({ size: 11, sign: 92 });
        const sr = DEC_2026_SCHEDULES.find((s) => s.key === 'sr')!;
        const senior = noticeLayout(SENIOR_NOTICE, backPageNotes(SENIOR_NOTICE, sr.notes));
        expect(senior.size).toBeGreaterThanOrEqual(9);
    });
});
