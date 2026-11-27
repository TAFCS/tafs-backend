/**
 * TAFSD-605 phase 5: bulk extracurricular vouchers over HTTP through the real
 * guards. Preview per (student, year), chunked issue that is safe to repeat,
 * students outside the run's filters or scope reported and never issued, the
 * run id on every voucher, and every money identity still holding.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CLASS_AUG, STUDENT, YEAR, seedSchool } from './helpers/fixtures';
import { EC_USERS, academicSnapshot, seedEcUsers } from './helpers/ec-fixtures';
import { ecInvariantProblems } from './helpers/ec-invariants';
import { todayPktKey } from '../../src/modules/extracurricular/ec-dates.util';

let app: INestApplication;
let prisma: PrismaService;
let manager: ReturnType<typeof client>;
let campusClerk: ReturnType<typeof client>;
let viewer: ReturnType<typeof client>;
let before: Awaited<ReturnType<typeof academicSnapshot>>;
let club: number;

const today = todayPktKey();

beforeAll(async () => {
    let jwt: JwtService;
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    await seedEcUsers(prisma);
    manager = client(app, tokenFor(jwt, EC_USERS.ecManager));
    campusClerk = client(app, tokenFor(jwt, EC_USERS.ecClerk));
    viewer = client(app, tokenFor(jwt, EC_USERS.ecViewer));
    before = await academicSnapshot(prisma);

    club = (await manager.post('/ec-fee-heads').send({ name: 'Swimming Club', frequency: 'MONTHLY', months: [9, 10] })).body.data.id;
    const assigned = await manager
        .post('/ec-student-charges/bulk-assign')
        .send({ fee_head_id: club, academic_year: YEAR, amount_source: 'CUSTOM', amount: 2000, class_ids: [CLASS_AUG] });
    expect(assigned.body.data.created).toBe(6); // A1, A2, B1 × Sep, Oct
});

afterAll(async () => {
    await app?.close();
});

const filters = { class_ids: [CLASS_AUG], fee_head_ids: [] as number[], months: [9], academic_years: [YEAR] };

describe('bulk extracurricular vouchers', () => {
    it('previews one voucher per student per year for the chosen month', async () => {
        const res = await manager.post('/ec-vouchers/bulk/preview').send(filters);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ students_matched: 3, students_with_charges: 3, vouchers_to_issue: 3, total_amount: 6000 });
        expect(res.body.data.eligible_student_ids.sort()).toEqual([STUDENT.A1, STUDENT.A2, STUDENT.B1].sort());
        expect(res.body.data.rows[0].description).toBe('SWIMMING CLUB (SEP 26)');
        expect(await prisma.ec_vouchers.count()).toBe(0);
    });

    it('issues a chunk once; repeating the chunk issues nothing more', async () => {
        const body = { ...filters, chunk_student_ids: [STUDENT.A1, STUDENT.A2], issue_date: today, run_id: 'run-0001-test' };
        const first = await manager.post('/ec-vouchers/bulk/issue').send(body);
        expect(first.status).toBe(200);
        expect(first.body.data).toMatchObject({ issued: 2, skipped: 0, failed: 0 });

        const again = await manager.post('/ec-vouchers/bulk/issue').send(body);
        expect(again.body.data).toMatchObject({ issued: 0, skipped: 2 });
        expect(again.body.data.results.every((r: any) => r.reason === 'Nothing left to issue')).toBe(true);

        const run = await manager.get('/ec-vouchers?bulk_run_id=run-0001-test');
        expect(run.body.data.meta.total).toBe(2);
        expect(await ecInvariantProblems(prisma as any)).toEqual([]);
    });

    it("reports a student outside the run's filters instead of issuing", async () => {
        const res = await manager.post('/ec-vouchers/bulk/issue').send({ ...filters, chunk_student_ids: [STUDENT.A_APR], issue_date: today, run_id: 'run-0001-test' });
        expect(res.body.data).toMatchObject({ issued: 0, skipped: 1 });
        expect(res.body.data.results[0].reason).toMatch(/selection/);
    });

    it('holds a campus-scoped user to their own campus', async () => {
        const preview = await campusClerk.post('/ec-vouchers/bulk/preview').send({ ...filters, months: [10] });
        expect(preview.body.data.eligible_student_ids.sort()).toEqual([STUDENT.A1, STUDENT.A2].sort());
        const res = await campusClerk.post('/ec-vouchers/bulk/issue').send({ ...filters, months: [10], chunk_student_ids: [STUDENT.B1], issue_date: today, run_id: 'run-0002-test' });
        expect(res.body.data).toMatchObject({ issued: 0, skipped: 1 });
        expect(await prisma.ec_vouchers.count({ where: { student_id: STUDENT.B1 } })).toBe(0);
    });

    it('lets a viewer preview but not issue', async () => {
        expect((await viewer.post('/ec-vouchers/bulk/preview').send(filters)).status).toBe(200);
        expect((await viewer.post('/ec-vouchers/bulk/issue').send({ ...filters, chunk_student_ids: [STUDENT.B1], issue_date: today, run_id: 'run-0003-test' })).status).toBe(403);
    });

    it('refuses a past valid-till date and a malformed run id', async () => {
        expect((await manager.post('/ec-vouchers/bulk/issue').send({ ...filters, chunk_student_ids: [STUDENT.B1], issue_date: today, expiry_date: '2020-01-01', run_id: 'run-0004-test' })).status).toBe(400);
        expect((await manager.post('/ec-vouchers/bulk/issue').send({ ...filters, chunk_student_ids: [STUDENT.B1], issue_date: today, run_id: 'x' })).status).toBe(400);
    });

    it('left every academic table exactly as it was', async () => {
        expect(await academicSnapshot(prisma)).toEqual(before);
    });
});
