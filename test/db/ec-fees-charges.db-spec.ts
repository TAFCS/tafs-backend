/**
 * TAFSD-605 phase 2: Extracurricular Fees → Student Charges, over HTTP through
 * the real guards. One student's grid (add, change, remove, the lock once a
 * charge is on a voucher), class amounts per student, bulk assign / remove with
 * previews, campus scope, and "academic tables untouched".
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, CAMPUS_B, CLASS_APR, CLASS_AUG, STUDENT, USERS, YEAR, seedSchool } from './helpers/fixtures';
import { EC_USERS, academicSnapshot, seedEcUsers } from './helpers/ec-fixtures';

let app: INestApplication;
let prisma: PrismaService;
let manager: ReturnType<typeof client>;
let campusClerk: ReturnType<typeof client>;
let viewer: ReturnType<typeof client>;
let academicClerk: ReturnType<typeof client>;
let before: Awaited<ReturnType<typeof academicSnapshot>>;
let club: number; // monthly: Sep, Oct, Mar
let kit: number; // one-time: Sep

beforeAll(async () => {
    let jwt: JwtService;
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    await seedEcUsers(prisma);
    manager = client(app, tokenFor(jwt, EC_USERS.ecManager));
    campusClerk = client(app, tokenFor(jwt, EC_USERS.ecClerk));
    viewer = client(app, tokenFor(jwt, EC_USERS.ecViewer));
    academicClerk = client(app, tokenFor(jwt, USERS.clerk));
    before = await academicSnapshot(prisma);

    club = (await manager.post('/ec-fee-heads').send({ name: 'Swimming Club', frequency: 'MONTHLY', months: [9, 10, 3] })).body.data.id;
    kit = (await manager.post('/ec-fee-heads').send({ name: 'Scouts Kit', frequency: 'ONE_TIME', months: [9] })).body.data.id;
    await manager.put('/ec-class-fee-schedule').send({
        academic_year: YEAR,
        cells: [
            { class_id: CLASS_AUG, fee_head_id: club, campus_id: null, amount: 2000 },
            { class_id: CLASS_AUG, fee_head_id: club, campus_id: CAMPUS_A, amount: 2500 },
            { class_id: CLASS_APR, fee_head_id: club, campus_id: null, amount: 3000 },
        ],
    });
});

afterAll(async () => {
    await app?.close();
});

const save = (who: ReturnType<typeof client>, cc: number, cells: object[]) =>
    who.post(`/ec-student-charges/student/${cc}/save`).send({ academic_year: YEAR, cells });

describe("one student's charges", () => {
    it('reports the class amount the student would get (campus beats all-campus)', async () => {
        const res = await manager.get(`/ec-student-charges/student/${STUDENT.A1}/class-amounts?academic_year=${YEAR}`);
        expect(res.status).toBe(200);
        const swim = res.body.data.find((h: any) => h.fee_head_id === club);
        expect(swim.amount).toBe(2500);
        expect(res.body.data.find((h: any) => h.fee_head_id === kit).amount).toBeNull();

        const b = await manager.get(`/ec-student-charges/student/${STUDENT.B1}/class-amounts?academic_year=${YEAR}`);
        expect(b.body.data.find((h: any) => h.fee_head_id === club).amount).toBe(2000);
    });

    it('adds, changes and removes charges, dating each month by the class term', async () => {
        const add = await save(manager, STUDENT.A_APR, [
            { fee_head_id: club, target_month: 9, amount: 3000, source: 'SCHEDULE' },
            { fee_head_id: club, target_month: 3, amount: 3000, source: 'SCHEDULE' },
            { fee_head_id: kit, target_month: 9, amount: 4500 },
        ]);
        expect(add.status).toBe(200);
        expect(add.body.data).toEqual({ created: 3, updated: 0, removed: 0 });

        const list = await manager.get(`/ec-student-charges/student/${STUDENT.A_APR}?academic_years=${YEAR}`);
        const march = list.body.data.charges.find((c: any) => c.fee_head_id === club && c.target_month === 3);
        expect(march).toMatchObject({ period: '2027-03-01', period_label: 'MAR 27', amount: 3000, status: 'NOT_ISSUED', source: 'SCHEDULE', locked_reason: null });
        expect(list.body.data.student).toMatchObject({ cc: STUDENT.A_APR, class_id: CLASS_APR });

        const change = await save(manager, STUDENT.A_APR, [
            { fee_head_id: club, target_month: 3, amount: 2800 },
            { fee_head_id: kit, target_month: 9, amount: null },
        ]);
        expect(change.body.data).toEqual({ created: 0, updated: 1, removed: 1 });

        const audit = await prisma.audit_logs.findMany({ where: { entity_type: 'EC_STUDENT_CHARGE', student_id: STUDENT.A_APR } });
        expect(audit.length).toBeGreaterThan(0);
    });

    it("refuses a month the head isn't charged in, an inactive head, and a duplicate cell", async () => {
        expect((await save(manager, STUDENT.A1, [{ fee_head_id: club, target_month: 12, amount: 2500 }])).status).toBe(400);
        await manager.patch(`/ec-fee-heads/${kit}`).send({ is_active: false });
        expect((await save(manager, STUDENT.A1, [{ fee_head_id: kit, target_month: 9, amount: 100 }])).status).toBe(400);
        await manager.patch(`/ec-fee-heads/${kit}`).send({ is_active: true });
        expect(
            (await save(manager, STUDENT.A1, [
                { fee_head_id: club, target_month: 9, amount: 1 },
                { fee_head_id: club, target_month: 9, amount: 2 },
            ])).status,
        ).toBe(400);
    });

    it('locks a charge once it is on a voucher, and rolls the whole save back', async () => {
        const charge = await prisma.ec_student_charges.findFirstOrThrow({ where: { student_id: STUDENT.A_APR, fee_head_id: club, target_month: 9 } });
        const voucher = await prisma.ec_vouchers.create({
            data: {
                student_id: STUDENT.A_APR, campus_id: CAMPUS_A, class_id: CLASS_APR, academic_year: YEAR,
                issue_date: new Date('2026-09-01'), expiry_date: new Date('2026-09-15'), total_amount: 3000, bank_snapshot: {},
            },
        });
        await prisma.ec_student_charges.update({ where: { id: charge.id }, data: { current_voucher_id: voucher.id, status: 'ISSUED' } });

        const res = await save(manager, STUDENT.A_APR, [
            { fee_head_id: club, target_month: 10, amount: 3000 },
            { fee_head_id: club, target_month: 9, amount: 1 },
        ]);
        expect(res.status).toBe(409);
        // Rolled back: October was not added.
        expect(await prisma.ec_student_charges.count({ where: { student_id: STUDENT.A_APR, fee_head_id: club, target_month: 10 } })).toBe(0);
        expect((await save(manager, STUDENT.A_APR, [{ fee_head_id: club, target_month: 9, amount: null }])).status).toBe(409);

        const list = await manager.get(`/ec-student-charges/student/${STUDENT.A_APR}`);
        expect(list.body.data.charges.find((c: any) => c.id === charge.id).locked_reason).toBe('ON_VOUCHER');
    });

    it('keeps students outside scope out of reach, and enforces the actions', async () => {
        expect((await campusClerk.get(`/ec-student-charges/student/${STUDENT.B1}`)).status).toBe(404);
        expect((await campusClerk.get(`/ec-student-charges/student/${STUDENT.A1}`)).status).toBe(200);
        expect((await viewer.get(`/ec-student-charges/student/${STUDENT.A1}`)).status).toBe(200);
        expect((await save(viewer, STUDENT.A1, [{ fee_head_id: club, target_month: 9, amount: 2500 }])).status).toBe(403);
        expect((await academicClerk.get(`/ec-student-charges/student/${STUDENT.A1}`)).status).toBe(403);
        // The shared student search lets EC holders in.
        expect((await viewer.get('/students/search-simple?q=Test')).status).toBe(200);
    });
});

describe('bulk assign and remove', () => {
    const assign = { fee_head_id: 0, academic_year: YEAR, amount_source: 'SCHEDULE' };

    it('needs the students named by campus, class, section or C.C.', async () => {
        expect((await manager.post('/ec-student-charges/bulk-assign/preview').send({ ...assign, fee_head_id: club })).status).toBe(400);
    });

    it('previews per student, skipping months already charged and classes without an amount', async () => {
        await save(manager, STUDENT.A1, [{ fee_head_id: club, target_month: 9, amount: 2500 }]);
        const res = await manager.post('/ec-student-charges/bulk-assign/preview').send({ ...assign, fee_head_id: club, campus_ids: [CAMPUS_A] });
        expect(res.status).toBe(200);
        const byCc = new Map(res.body.data.rows.map((r: any) => [r.cc, r]));
        expect(byCc.get(STUDENT.A1)).toMatchObject({ amount: 2500, months_to_create: [10, 3], skip_reason: null });
        expect(byCc.get(STUDENT.A2)).toMatchObject({ amount: 2500, months_to_create: [9, 10, 3] });
        expect(byCc.has(STUDENT.B1)).toBe(false);
        // Nothing was written by the preview.
        expect(await prisma.ec_student_charges.count({ where: { student_id: STUDENT.A2 } })).toBe(0);

        const kitPreview = await manager.post('/ec-student-charges/bulk-assign/preview').send({ ...assign, fee_head_id: kit, class_ids: [CLASS_AUG] });
        expect(kitPreview.body.data.skipped.no_class_amount).toBe(3);
        expect(kitPreview.body.data.charges_to_create).toBe(0);
    });

    it('charges in bulk once; a re-run adds nothing', async () => {
        const body = { ...assign, fee_head_id: club, class_ids: [CLASS_AUG] };
        const first = await manager.post('/ec-student-charges/bulk-assign').send(body);
        expect(first.status).toBe(200);
        // A1 needed Oct+Mar, A2 and B1 all three months.
        expect(first.body.data.created).toBe(2 + 3 + 3);
        const b1 = await prisma.ec_student_charges.findMany({ where: { student_id: STUDENT.B1, fee_head_id: club } });
        expect(b1.map((c) => Number(c.amount))).toEqual([2000, 2000, 2000]);

        const again = await manager.post('/ec-student-charges/bulk-assign').send(body);
        expect(again.body.data.created).toBe(0);
        expect(again.body.data.skipped.already_charged).toBe(3);
    });

    it('uses one custom amount for everyone when asked', async () => {
        const res = await manager.post('/ec-student-charges/bulk-assign').send({ fee_head_id: kit, academic_year: YEAR, amount_source: 'CUSTOM', amount: 4500, student_ids: [STUDENT.A1, STUDENT.A2] });
        expect(res.body.data.created).toBe(2);
        expect((await manager.post('/ec-student-charges/bulk-assign').send({ fee_head_id: kit, academic_year: YEAR, amount_source: 'CUSTOM', student_ids: [STUDENT.A1] })).status).toBe(400);
    });

    it('holds a campus-scoped user to their own campus', async () => {
        expect((await campusClerk.post('/ec-student-charges/bulk-assign/preview').send({ ...assign, fee_head_id: club, campus_ids: [CAMPUS_B] })).status).toBe(403);
        const scoped = await campusClerk.post('/ec-student-charges/bulk-remove/preview').send({ fee_head_id: club, academic_year: YEAR, class_ids: [CLASS_AUG] });
        expect(scoped.status).toBe(200);
        expect(scoped.body.data.rows.map((r: any) => r.cc)).not.toContain(STUDENT.B1);
    });

    it('removes only charges not yet on a voucher, and reports the rest', async () => {
        const a1Sep = await prisma.ec_student_charges.findFirstOrThrow({ where: { student_id: STUDENT.A1, fee_head_id: club, target_month: 9 } });
        const voucher = await prisma.ec_vouchers.create({
            data: {
                student_id: STUDENT.A1, campus_id: CAMPUS_A, class_id: CLASS_AUG, academic_year: YEAR,
                issue_date: new Date('2026-09-01'), expiry_date: new Date('2026-09-15'), total_amount: 2500, bank_snapshot: {},
            },
        });
        await prisma.ec_student_charges.update({ where: { id: a1Sep.id }, data: { current_voucher_id: voucher.id, status: 'ISSUED' } });

        const body = { fee_head_id: club, academic_year: YEAR, months: [9], campus_ids: [CAMPUS_A] };
        const preview = await manager.post('/ec-student-charges/bulk-remove/preview').send(body);
        // A1's September (just issued) and the April student's September (issued above) are locked.
        expect(preview.body.data).toMatchObject({ charges_to_remove: 1, locked: 2, locked_by_reason: { ON_VOUCHER: 2, PAID: 0, WAIVED: 0 } });

        const done = await manager.post('/ec-student-charges/bulk-remove').send(body);
        expect(done.body.data.removed).toBe(1);
        expect(await prisma.ec_student_charges.findUnique({ where: { id: a1Sep.id } })).not.toBeNull();
        expect(await prisma.ec_student_charges.count({ where: { student_id: STUDENT.A2, fee_head_id: club, target_month: 9 } })).toBe(0);
    });

    it('refuses bulk work to people without the action', async () => {
        expect((await viewer.post('/ec-student-charges/bulk-assign/preview').send({ ...assign, fee_head_id: club, class_ids: [CLASS_AUG] })).status).toBe(403);
        expect((await viewer.post('/ec-student-charges/bulk-remove').send({ fee_head_id: club, academic_year: YEAR, class_ids: [CLASS_AUG] })).status).toBe(403);
    });
});

describe('separation from academic fees', () => {
    it('left every academic table exactly as it was', async () => {
        expect(await academicSnapshot(prisma)).toEqual(before);
    });
});
