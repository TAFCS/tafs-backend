/**
 * Student Directory: the certificate tabs (admission order, leaving
 * certificate and its PDF, the certificate log) and the Reports page
 * (strength, special categories, admissions and withdrawals, with exports).
 */
import ExcelJS from 'exceljs';
import { CAMPUS_A, CAMPUS_B, CLASS_AUG, STUDENT } from '../helpers/fixtures';
import { GR } from './directory-fixtures';
import { directorySuite } from './suite';

const ctx = directorySuite();

const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('certificates', () => {
    it('builds the admission order', async () => {
        const res = await ctx.as.dirClerk.get(`/enrollments/${STUDENT.A1}/admission-order`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            cc: STUDENT.A1, gr_number: GR.A1, full_name: 'Test Student One', class_name: 'Class VI', house_name: 'RED', father_name: 'TEST FATHER',
        });
        expect(res.body.data.link_gr_number).toContain(GR.A2);
    });

    it('issues a leaving certificate only to a student who has left, keeping the same SLC number', async () => {
        const enrolled = await ctx.as.dirClerk.get(`/enrollments/${STUDENT.A1}/leaving-certificate`);
        expect(enrolled.status).toBe(400);
        expect(enrolled.body.message).toMatch(/only be generated for students whose status is 'LEFT'/);

        await ctx.prisma.students.update({ where: { cc: STUDENT.A1 }, data: { status: 'LEFT' } });
        const first = await ctx.as.dirClerk.get(`/enrollments/${STUDENT.A1}/leaving-certificate`);
        expect(first.status).toBe(200);
        const slc = first.body.data.slc_number;
        expect(Number(slc)).toBeGreaterThan(250);
        expect(first.body.data).toMatchObject({ cc: STUDENT.A1, gr_number: GR.A1 });

        const again = await ctx.as.dirClerk.get(`/enrollments/${STUDENT.A1}/leaving-certificate`);
        expect(again.body.data.slc_number).toBe(slc);
        expect((await ctx.prisma.students.findUniqueOrThrow({ where: { cc: STUDENT.A1 } })).slc_number).toBe(Number(slc));
    });

    it('renders the leaving certificate as a PDF', async () => {
        await ctx.prisma.students.update({ where: { cc: STUDENT.A1 }, data: { status: 'LEFT' } });
        const res = await ctx.as.dirClerk.post(`/enrollments/${STUDENT.A1}/leaving-certificate/pdf`).send({}).buffer(true).parse(binary);
        expect(res.status).toBe(201);
        expect(res.headers['content-type']).toContain('application/pdf');
        expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
    });

    it('logs a generated certificate and lists it in the history', async () => {
        const logged = await ctx.as.dirClerk.post(`/enrollments/${STUDENT.A1}/log-certificate-generation`).send({ document_type: 'TRANSFER_ORDER', ref_number: 'TO-1' });
        expect(logged.status).toBe(201);

        let history: any[] = [];
        for (let i = 0; i < 30 && !history.some((h) => h.document_type === 'TRANSFER_ORDER'); i++) {
            history = (await ctx.as.dirClerk.get(`/enrollments/${STUDENT.A1}/certificate-history`)).body.data;
            await new Promise((r) => setTimeout(r, 50));
        }
        expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ document_type: 'TRANSFER_ORDER', ref_number: 'TO-1', generated_by: 'dbsuite.dirclerk' })]));
    });

    it('needs certificates.view and the student in scope', async () => {
        expect((await ctx.as.dirViewer.get(`/enrollments/${STUDENT.A1}/certificate-history`)).status).toBe(403);
        expect((await ctx.as.dirViewer.get(`/enrollments/${STUDENT.A1}/admission-order`)).status).toBe(403);
        expect((await ctx.as.dirClerk.get(`/enrollments/${STUDENT.B1}/admission-order`)).status).toBe(404);
        expect((await ctx.as.dirClerk.get(`/enrollments/${STUDENT.B1}/certificate-history`)).status).toBe(404);
    });
});

describe('strength report', () => {
    it('counts students per campus and class', async () => {
        const res = await ctx.as.admin.get('/student-reports/strength');
        expect(res.status).toBe(200);
        expect(res.body.data.totals.total).toBe(4);
        const byKey = Object.fromEntries(res.body.data.rows.map((r: any) => [r.key, r.total]));
        expect(byKey[`c:${CAMPUS_A}`]).toBe(3);
        expect(byKey[`c:${CAMPUS_A}|k:${CLASS_AUG}`]).toBe(2);
        expect(byKey[`c:${CAMPUS_B}`]).toBe(1);
    });

    it('splits by gender', async () => {
        const res = await ctx.as.admin.get('/student-reports/strength?split=gender');
        expect(res.body.data.totals.counts).toMatchObject({ MALE: 1, FEMALE: 1, UNKNOWN: 2 });
    });

    it('drills into a cell', async () => {
        const res = await ctx.as.admin.get(`/student-reports/strength/students?row=c:${CAMPUS_A}|k:${CLASS_AUG}&split=gender&column=FEMALE`);
        expect(res.status).toBe(200);
        expect(res.body.data.items.map((s: any) => s.cc)).toEqual([STUDENT.A2]);
    });

    it('is limited to the user\'s campus, and refuses another', async () => {
        expect((await ctx.as.dirClerk.get('/student-reports/strength')).body.data.totals.total).toBe(3);
        expect((await ctx.as.dirClerk.get(`/student-reports/strength?campus_id=${CAMPUS_B}`)).status).toBe(403);
    });

    it('exports the grid and the special-categories list to Excel', async () => {
        const strength = await ctx.as.admin.get('/student-reports/strength/export').buffer(true).parse(binary);
        expect(strength.status).toBe(200);
        expect(strength.headers['content-disposition']).toMatch(/student-strength-\d{4}-\d{2}-\d{2}\.xlsx/);
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(strength.body);
        expect(book.worksheets.length).toBeGreaterThan(0);

        const categories = await ctx.as.admin.get('/student-reports/categories/export?part=list').buffer(true).parse(binary);
        expect(categories.status).toBe(200);
        expect(categories.headers['content-type']).toContain('spreadsheetml');
    });

    it('exports need the export permission', async () => {
        expect((await ctx.as.dirViewer.get('/student-reports/strength')).status).toBe(200);
        expect((await ctx.as.dirViewer.get('/student-reports/strength/export')).status).toBe(403);
        expect((await ctx.as.dirViewer.get('/student-reports/categories/export')).status).toBe(403);
    });
});

describe('admissions and withdrawals report', () => {
    beforeEach(async () => {
        // A1 was admitted on 1 Aug 2026 (fixture doa); A2 left on 15 Oct 2026.
        await ctx.prisma.student_progression_periods.create({
            data: { student_cc: STUDENT.A1, campus_id: CAMPUS_A, class_id: CLASS_AUG, change_type: 'ENROLLED', valid_from: new Date('2026-08-01T05:00:00Z') },
        });
        await ctx.prisma.student_progression_periods.create({
            data: { student_cc: STUDENT.A2, campus_id: CAMPUS_A, class_id: CLASS_AUG, change_type: 'LEFT', valid_from: new Date('2026-10-15T05:00:00Z') },
        });
    });
    const range = 'from=2026-08-01&to=2026-10-31';

    it('counts admissions and withdrawals by month', async () => {
        const admitted = await ctx.as.admin.get(`/student-reports/movement?${range}&measure=admissions`);
        expect(admitted.status).toBe(200);
        expect(admitted.body.data.totals.total).toBe(1);
        expect(admitted.body.data.totals.counts['2026-08']).toBe(1);

        const withdrawn = await ctx.as.admin.get(`/student-reports/movement?${range}&measure=withdrawals`);
        expect(withdrawn.body.data.totals.total).toBe(1);
        expect(withdrawn.body.data.totals.counts['2026-10']).toBe(1);
    });

    it('lists the students behind a cell', async () => {
        const res = await ctx.as.admin.get(`/student-reports/movement/students?${range}&measure=withdrawals&row=c:${CAMPUS_A}&column=2026-10`);
        expect(res.status).toBe(200);
        expect(res.body.data.items).toEqual([expect.objectContaining({ cc: STUDENT.A2, type: 'LEFT', type_label: 'Left' })]);
    });

    it('exports to Excel, and rejects a backwards date range', async () => {
        const xlsx = await ctx.as.admin.get(`/student-reports/movement/export?${range}`).buffer(true).parse(binary);
        expect(xlsx.status).toBe(200);
        expect(xlsx.headers['content-disposition']).toMatch(/admissions-withdrawals-2026-08-01-to-2026-10-31\.xlsx/);

        const backwards = await ctx.as.admin.get('/student-reports/movement?from=2026-10-01&to=2026-08-01');
        expect(backwards.status).toBe(400);
        expect(backwards.body.message).toMatch(/start date is after the end date/);

        expect((await ctx.as.admin.get('/student-reports/movement?from=2026-13-01&to=2026-12-31')).status).toBe(400);
    });
});
