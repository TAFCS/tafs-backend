/**
 * Student Directory: finding and opening students (webapp /identity/students).
 * List and search, the shared search box, opening a record (both record
 * routes), guardians, photo history, Excel export, benefit-expiry alerts, the
 * uniform-photo banner, and the history tabs.
 */
import ExcelJS from 'exceljs';
import { CAMPUS_B, CLASS_AUG, STUDENT, YEAR } from '../helpers/fixtures';
import { FAMILY, GR, HOUSE } from './directory-fixtures';
import { directorySuite } from './suite';

const ctx = directorySuite();

const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const ccsOf = (items: any[]) => items.map((i) => i.cc).sort();

describe('student list (GET /students)', () => {
    it('lists every student for an unrestricted user, newest first', async () => {
        const res = await ctx.as.admin.get('/students?limit=50');
        expect(res.status).toBe(200);
        expect(ccsOf(res.body.data.items)).toEqual([STUDENT.A1, STUDENT.A2, STUDENT.A_APR, STUDENT.B1].sort());
        expect(res.body.data.pagination).toMatchObject({ page: 1, total: 4 });
    });

    it('searches by name, by GR and by guardian', async () => {
        const byName = await ctx.as.admin.get('/students?search=Student%20One');
        expect(ccsOf(byName.body.data.items)).toEqual([STUDENT.A1]);
        expect(byName.body.data.items[0].matched_on).toBe('Name');

        const byGr = await ctx.as.admin.get(`/students?search=${GR.A2}`);
        expect(ccsOf(byGr.body.data.items)).toContain(STUDENT.A2);

        const byGuardian = await ctx.as.admin.get('/students?search=TEST%20FATHER');
        expect(ccsOf(byGuardian.body.data.items)).toEqual([STUDENT.A1, STUDENT.A2].sort());
    });

    it('filters by class and by status', async () => {
        const inClass = await ctx.as.admin.get(`/students?class_id=${CLASS_AUG}&limit=50`);
        expect(ccsOf(inClass.body.data.items)).toEqual([STUDENT.A1, STUDENT.A2, STUDENT.B1].sort());

        await ctx.prisma.students.update({ where: { cc: STUDENT.A2 }, data: { status: 'LEFT' } });
        const left = await ctx.as.admin.get('/students?status=LEFT');
        expect(ccsOf(left.body.data.items)).toEqual([STUDENT.A2]);
    });

    it('shows a campus-scoped user only their campus, and refuses another campus outright', async () => {
        const res = await ctx.as.dirClerk.get('/students?limit=50');
        expect(res.status).toBe(200);
        expect(ccsOf(res.body.data.items)).toEqual([STUDENT.A1, STUDENT.A2, STUDENT.A_APR].sort());

        expect((await ctx.as.dirClerk.get(`/students?campus_id=${CAMPUS_B}`)).status).toBe(403);
    });

    it('rejects an unknown query parameter', async () => {
        expect((await ctx.as.admin.get('/students?colour=red')).status).toBe(400);
    });
});

describe('search box (GET /students/search-simple)', () => {
    it('finds a student by name, and by exact CC', async () => {
        const byName = await ctx.as.admin.get('/students/search-simple?q=Campus%20B');
        expect(byName.status).toBe(200);
        expect(byName.body.data.map((s: any) => s.cc)).toEqual([STUDENT.B1]);

        const byCc = await ctx.as.admin.get(`/students/search-simple?q=${STUDENT.A2}`);
        expect(byCc.body.data[0]).toMatchObject({ cc: STUDENT.A2, matched_on: 'C.C.' });
    });

    it('never shows a campus-scoped user a student from another campus', async () => {
        const res = await ctx.as.dirClerk.get('/students/search-simple?q=Test%20Student');
        expect(res.status).toBe(200);
        expect(res.body.data.map((s: any) => s.cc)).not.toContain(STUDENT.B1);
    });

    it('returns nothing for a blank query', async () => {
        expect((await ctx.as.admin.get('/students/search-simple?q=')).body.data).toEqual([]);
    });
});

describe('opening a student', () => {
    it('GET /students/:id returns the profile with family and guardians', async () => {
        const res = await ctx.as.admin.get(`/students/${STUDENT.A1}`);
        expect(res.status).toBe(200);
        const s = res.body.data;
        expect(s).toMatchObject({ cc: STUDENT.A1, student_full_name: 'Test Student One', gr_number: GR.A1, enrollment_status: 'ENROLLED', family_id: FAMILY });
        expect(s.primary_guardian_name).toBe('TEST FATHER');
        expect(s.siblings.map((x: any) => x.cc)).toContain(STUDENT.A2);
    });

    it('GET /staff-editing/students/:id returns the editable record', async () => {
        const res = await ctx.as.admin.get(`/staff-editing/students/${STUDENT.A1}`);
        expect(res.status).toBe(200);
        const s = res.body.data;
        expect(s).toMatchObject({ cc: STUDENT.A1, full_name: 'Test Student One', house_id: HOUSE.RED, house_name: 'RED', class_id: CLASS_AUG });
        // Registered after CC 7525 and still on an admission photo (TAFSD-527 trigger).
        expect(s.uniform_photo_pending).toBe(true);
        expect(s.guardians.map((g: any) => g.relationship).sort()).toEqual(['FATHER', 'MOTHER']);
    });

    it('lists the record sheet with search (GET /staff-editing/students)', async () => {
        const res = await ctx.as.admin.get('/staff-editing/students?search=Student%20Two');
        expect(res.status).toBe(200);
        expect(res.body.data.items.map((s: any) => s.cc)).toEqual([STUDENT.A2]);
    });

    it('lists guardians and photo history', async () => {
        const guardians = await ctx.as.admin.get(`/staff-editing/students/${STUDENT.A2}/guardians`);
        expect(guardians.status).toBe(200);
        expect(guardians.body.data.map((g: any) => g.full_name).sort()).toEqual(['TEST FATHER', 'TEST MOTHER']);

        await ctx.prisma.student_photo_history.create({ data: { student_id: STUDENT.A1, url: 'http://mock-storage/a.jpg', uploaded_by: 'x' } });
        const photos = await ctx.as.admin.get(`/staff-editing/students/${STUDENT.A1}/photo-history`);
        expect(photos.status).toBe(200);
        expect(photos.body.data.map((p: any) => p.url)).toEqual(['http://mock-storage/a.jpg']);
    });

    it('404s an unknown student and 400s a non-numeric id', async () => {
        expect((await ctx.as.admin.get('/students/999999')).status).toBe(404);
        expect((await ctx.as.admin.get('/staff-editing/students/999999')).status).toBe(404);
        expect((await ctx.as.admin.get('/students/abc')).status).toBe(400);
    });

    it('a campus-scoped user gets 404 for a student at another campus, on both record routes', async () => {
        expect((await ctx.as.dirClerk.get(`/students/${STUDENT.A1}`)).status).toBe(200);
        expect((await ctx.as.dirClerk.get(`/students/${STUDENT.B1}`)).status).toBe(404);
        expect((await ctx.as.dirClerk.get(`/staff-editing/students/${STUDENT.B1}`)).status).toBe(404);
        expect((await ctx.as.dirClerk.get(`/staff-editing/students/${STUDENT.B1}/guardians`)).status).toBe(404);
    });
});

describe('export (GET /students/export)', () => {
    it('downloads the filtered directory as Excel', async () => {
        const res = await ctx.as.admin.get(`/students/export?class_id=${CLASS_AUG}`).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('spreadsheetml');
        expect(res.headers['content-disposition']).toMatch(/student-directory-\d{4}-\d{2}-\d{2}\.xlsx/);

        const book = new ExcelJS.Workbook();
        await book.xlsx.load(res.body);
        const sheet = book.getWorksheet('Students')!;
        expect(sheet.rowCount).toBe(1 + 3); // header + the three Class VI students
    });

    it('needs the export permission', async () => {
        expect((await ctx.as.dirViewer.get('/students/export')).status).toBe(403);
    });
});

describe('alerts and banners', () => {
    it('lists special categories ending soon (GET /students/fee-benefit-expiry-alerts)', async () => {
        const cat = await ctx.prisma.student_categories.findUniqueOrThrow({ where: { code: 'FEE_ENDOWMENT' } });
        const soon = new Date(Date.now() + 5 * 86400000);
        await ctx.prisma.student_category_assignments.create({
            data: { student_id: STUDENT.A1, category_id: cat.id, reason: 'approved', until: soon, updated_at: new Date() },
        });
        const res = await ctx.as.admin.get('/students/fee-benefit-expiry-alerts?within_days=14');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([
            expect.objectContaining({ student_id: STUDENT.A1, benefit_type: 'FEE_ENDOWMENT', days_remaining: expect.any(Number) }),
        ]);
    });

    it('counts students still on their admission photo (GET /uniform-photos/summary)', async () => {
        const all = await ctx.as.admin.get('/uniform-photos/summary');
        expect(all.status).toBe(200);
        expect(all.body.data).toMatchObject({ total: 4, no_photo: 4 });

        const scoped = await ctx.as.dirClerk.get('/uniform-photos/summary');
        expect(scoped.body.data.total).toBe(3);
    });
});

describe('history tabs', () => {
    it('shows progression, academic history and house history', async () => {
        await ctx.prisma.student_progression_periods.create({
            data: { student_cc: STUDENT.A1, campus_id: 1, class_id: CLASS_AUG, change_type: 'ENROLLED', valid_from: new Date('2026-08-01') },
        });
        await ctx.prisma.student_academic_history.create({
            data: { student_cc: STUDENT.A1, class_id: CLASS_AUG, change_type: 'PROMOTED', academic_year: YEAR },
        });
        await ctx.prisma.audit_logs.create({
            data: { entity_type: 'STUDENT', entity_id: String(STUDENT.A1), action: 'UPDATED', field: 'student.house_id', old_value: String(HOUSE.BLUE), new_value: String(HOUSE.RED), changed_by: 'x', student_id: STUDENT.A1 },
        });

        const progression = await ctx.as.admin.get(`/students/${STUDENT.A1}/progression`);
        expect(progression.status).toBe(200);
        expect(progression.body.data.map((p: any) => p.change_type)).toEqual(['ENROLLED']);

        const academic = await ctx.as.admin.get(`/students/${STUDENT.A1}/academic-history`);
        expect(academic.body.data.map((p: any) => p.change_type)).toEqual(['PROMOTED']);

        const houses = await ctx.as.admin.get(`/students/${STUDENT.A1}/house-history`);
        expect(houses.body.data).toEqual([
            expect.objectContaining({ from_house: expect.objectContaining({ house_name: 'BLUE' }), to_house: expect.objectContaining({ house_name: 'RED' }) }),
        ]);
    });

    it('shows the activity timeline (GET /audit-logs?student_id=)', async () => {
        await ctx.prisma.audit_logs.create({
            data: { entity_type: 'STUDENT', entity_id: String(STUDENT.A1), action: 'UPDATED', field: 'student.full_name', changed_by: 'x', student_id: STUDENT.A1, note: 'renamed' },
        });
        const res = await ctx.as.dirClerk.get(`/audit-logs?student_id=${STUDENT.A1}`);
        expect(res.status).toBe(200);
        expect(res.body.data.total).toBe(1);
        expect(res.body.data.data[0]).toMatchObject({ note: 'renamed', student_id: STUDENT.A1 });
    });

    it('shows payment history for a year, and requires the year', async () => {
        expect((await ctx.as.admin.get(`/students/${STUDENT.A1}/payment-history`)).status).toBe(400);
        const res = await ctx.as.admin.get(`/students/${STUDENT.A1}/payment-history?academic_year=${YEAR}`);
        expect(res.status).toBe(200);
        expect(res.body.data.stats).toMatchObject({ total_due: 0, total_paid: 0 });
        expect((await ctx.as.dirClerk.get(`/students/${STUDENT.B1}/payment-history?academic_year=${YEAR}`)).status).toBe(404);
    });
});
