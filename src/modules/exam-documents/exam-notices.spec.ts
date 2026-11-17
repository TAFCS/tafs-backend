import { CAMBRIDGE_NOTICE, JUNIOR_NOTICE, SENIOR_NOTICE, noticeForClass, noticeItemText } from './exam-notices';
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
        expect(buildExamDocPage(input(9)).notice).toBe(SENIOR_NOTICE);
        expect(buildExamDocPage(input(9)).assessment).toBe('FINAL');
        expect(buildExamDocPage(input(15)).notice).toBeNull();
    });

    it('fits the Cambridge notice and ten O Level notes on one page, sign included', () => {
        const o = DEC_2026_SCHEDULES.find((s) => s.key === 'o')!;
        const withNotes = noticeLayout(CAMBRIDGE_NOTICE, o.notes);
        expect(withNotes.sign).toBeGreaterThan(0);
        expect(withNotes.size).toBeGreaterThanOrEqual(9);
        expect(noticeLayout(CAMBRIDGE_NOTICE, [])).toEqual({ size: 11, sign: 92 });
    });
});
