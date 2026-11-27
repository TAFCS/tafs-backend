import { buildExamDocPage } from './exam-document-page';
import { ExamDocPage, frontFit } from './ExamDocumentPDF';
import { pdfPageCount, settleFrontFit, SLACK_STEP } from './exam-front-fit';
import { timesLines, timesWidth } from './times-metrics';

const page = (classId: number, documentNotes: string[], papers = 10): ExamDocPage =>
    buildExamDocPage({
        schedule: {
            title: 'FIRST SEMESTER ASSESSMENTS',
            segmentLine: 'JUNIOR CAMBRIDGE',
            academicYear: '2026-2027',
            notes: [],
            documentNotes,
            campusName: 'North Nazimabad Campus',
            campusAddress: null,
            papers: Array.from({ length: papers }, (_, i) => ({
                class_id: classId,
                paper_date: new Date(Date.UTC(2026, 11, 11 + i)),
                time_text: '8:00 – 11:30',
                subject: 'ENGLISH LANGUAGE',
                code: null,
            })),
        },
        classId,
        className: 'X',
        sectionName: 'A',
        serialNo: 1,
        issuedAt: new Date('2026-12-09T05:00:00Z'),
        student: { cc: 1, gr: '1', fullName: 'A B', father: 'C', dob: null, gender: null },
        photo: null,
    });

/** A fake render: a PDF of `pages(d)` pages, as react-pdf writes its page objects. */
const fakeRender = (pages: (d: ExamDocPage) => number) => async (d: ExamDocPage) => {
    const n = pages(d);
    return Buffer.from(`<< /Type /Pages /Count ${n} >>` + Array<string>(n).fill('<< /Type /Page /Parent 1 0 R >>').join('\n'));
};

describe('TAFSD-555 measuring the front note', () => {
    it('measures with the Times metrics react-pdf lays out with', () => {
        expect(timesWidth('A', 'b', 10)).toBeCloseTo(7.22);
        expect(timesWidth('i', 'r', 10)).toBeCloseTo(2.78);
        // Bold capitals run wider than roman ones.
        expect(timesWidth('ONLY SIMPLE CALCULATORS', 'b', 9)).toBeGreaterThan(timesWidth('ONLY SIMPLE CALCULATORS', 'r', 9));
    });

    it('wraps whole words to the column, and splits a word longer than it', () => {
        expect(timesLines('NO BAGS.', 'b', 9.5, 495)).toBe(1);
        const long = 'IN CASE OF SCHOOL CLOSURE DUE TO ANY CITY DISTURBANCE, THE ASSESSMENT OF THAT DAY WILL BE TAKEN AFTER THE LAST ONE.';
        expect(timesLines(long, 'b', 9.5, 495)).toBe(2);
        expect(timesLines(long, 'b', 6.5, 495)).toBe(1);
        expect(timesLines('W'.repeat(100), 'r', 10, 200)).toBe(Math.ceil(timesWidth('W'.repeat(100), 'r', 10) / 200));
    });
});

describe('TAFSD-555 settling the front page by rendering it', () => {
    it('counts the pages react-pdf wrote, not the page tree', () => {
        expect(pdfPageCount(Buffer.from('<< /Type /Pages >> << /Type /Page >> << /Type /Page>>'))).toBe(2);
        expect(pdfPageCount(Buffer.alloc(0))).toBe(0);
    });

    it('keeps the measured fit when the page holds on one sheet', async () => {
        const d = page(4, ['BRING A CLEAR POUCH.']);
        const got = await settleFrontFit(d, fakeRender(() => 1));
        expect(got).toMatchObject({ slack: 0, fits: true, fit: frontFit(d) });
    });

    it('takes room back a step at a time until the page holds', async () => {
        const notes = Array<string>(10).fill('NO LENDING OR BORROWING WILL BE ALLOWED, STUDENTS HAVE TO BRING TRANSPARENT POUCHES.');
        const d = page(18, notes);
        const renders: number[] = [];
        // Spills until 3 steps of room are taken back.
        const got = await settleFrontFit(
            d,
            fakeRender((x) => {
                renders.push(x.frontSlack ?? 0);
                return (x.frontSlack ?? 0) >= 3 * SLACK_STEP ? 1 : 2;
            }),
        );
        expect(got.fits).toBe(true);
        expect(got.slack).toBeGreaterThanOrEqual(3 * SLACK_STEP);
        expect(got.fit.noteSize).toBeLessThanOrEqual(frontFit(d).noteSize);
        // No render is spent on a step that prints the same page as the one before.
        const fits = renders.map((s) => JSON.stringify(frontFit({ ...d, frontSlack: s })));
        expect(new Set(fits).size).toBe(fits.length);
    });

    it('says a note does not fit when even the smallest sizes spill', async () => {
        const d = page(4, Array<string>(12).fill('X '.repeat(120)));
        const got = await settleFrontFit(d, fakeRender(() => 2));
        expect(got.fits).toBe(false);
        expect(got.fit).toMatchObject({ size: 6.5, noteSize: 6.5 });
    });

    it('leaves the standard lines alone', async () => {
        const d = page(4, []);
        const got = await settleFrontFit(d, fakeRender(() => 1));
        expect(got).toMatchObject({ slack: 0, fits: true, fullNoteSize: 9.5 });
    });
});
