/**
 * TAFSD-605 phase 1: Extracurricular Fees setup. Fee heads and class amounts,
 * driven over HTTP through the real guards: access is per person (no role gets
 * an EC tile), campus scope holds on class amounts, and nothing here touches an
 * academic table.
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

const NEXT_YEAR = '2027-2028';

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
});

afterAll(async () => {
    await app?.close();
});

describe('extracurricular fee heads', () => {
    let scoutsId: number;

    it('adds a head with its name upper-cased and months in school-year order', async () => {
        const res = await manager.post('/ec-fee-heads').send({ name: '  sports   club ', frequency: 'MONTHLY', months: [1, 9, 8, 9] });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ name: 'SPORTS CLUB', frequency: 'MONTHLY', months: [8, 9, 1], is_active: true });

        const scouts = await manager.post('/ec-fee-heads').send({ name: 'Scouts Registration', frequency: 'ONE_TIME', months: [11] });
        expect(scouts.status).toBe(201);
        scoutsId = scouts.body.data.id;

        const audit = await prisma.audit_logs.findFirst({ where: { entity_type: 'EC_FEE_HEAD', entity_id: String(scoutsId), action: 'CREATED' } });
        expect(audit?.section).toBe('finance');
    });

    it('refuses a one-time head with two months, an empty month list and a duplicate name', async () => {
        expect((await manager.post('/ec-fee-heads').send({ name: 'Trip', frequency: 'ONE_TIME', months: [10, 11] })).status).toBe(400);
        expect((await manager.post('/ec-fee-heads').send({ name: 'Trip', frequency: 'MONTHLY', months: [] })).status).toBe(400);
        expect((await manager.post('/ec-fee-heads').send({ name: 'scouts registration', frequency: 'ONE_TIME', months: [11] })).status).toBe(409);
    });

    it('lists with multi-value filters where empty means all', async () => {
        const all = await manager.get('/ec-fee-heads');
        expect(all.body.data.map((h: any) => h.name).sort()).toEqual(['SCOUTS REGISTRATION', 'SPORTS CLUB']);
        const oneTime = await manager.get('/ec-fee-heads?frequencies=ONE_TIME');
        expect(oneTime.body.data.map((h: any) => h.name)).toEqual(['SCOUTS REGISTRATION']);
        const both = await manager.get('/ec-fee-heads?frequencies=ONE_TIME,MONTHLY&states=ACTIVE,INACTIVE');
        expect(both.body.data).toHaveLength(2);
    });

    it('searches server-side: empty text finds nothing, a small projection otherwise', async () => {
        expect((await viewer.get('/ec-fee-heads/search-simple?q=')).body.data).toEqual([]);
        const hits = await viewer.get('/ec-fee-heads/search-simple?q=scout');
        expect(hits.status).toBe(200);
        expect(hits.body.data).toEqual([{ id: scoutsId, name: 'SCOUTS REGISTRATION', frequency: 'ONE_TIME', is_active: true }]);
    });

    it('deactivates, and refuses to delete a head a student is charged for', async () => {
        const off = await manager.patch(`/ec-fee-heads/${scoutsId}`).send({ is_active: false });
        expect(off.body.data.is_active).toBe(false);
        expect((await manager.get('/ec-fee-heads/options')).body.data.map((h: any) => h.id)).not.toContain(scoutsId);

        await prisma.ec_student_charges.create({
            data: { student_id: STUDENT.A1, fee_head_id: scoutsId, academic_year: YEAR, target_month: 11, period: new Date('2026-11-01'), amount: 16000 },
        });
        expect((await manager.delete(`/ec-fee-heads/${scoutsId}`)).status).toBe(409);
        await prisma.ec_student_charges.deleteMany({});
        expect((await manager.delete(`/ec-fee-heads/${scoutsId}`)).status).toBe(200);
    });

    it('lets in only people granted the tile, and only for the actions they hold', async () => {
        expect((await academicClerk.get('/ec-fee-heads')).status).toBe(403);
        expect((await academicClerk.get('/ec-fee-heads/options')).status).toBe(403);
        expect((await viewer.get('/ec-fee-heads')).status).toBe(200);
        expect((await viewer.post('/ec-fee-heads').send({ name: 'Chess Club', frequency: 'MONTHLY', months: [9] })).status).toBe(403);
    });
});

describe('extracurricular class amounts', () => {
    let headId: number;

    beforeAll(async () => {
        headId = (await prisma.ec_fee_heads.findFirstOrThrow({ where: { name: 'SPORTS CLUB' } })).id;
    });

    it('sets all-campus and campus amounts, and clears a cell with null', async () => {
        const res = await manager.put('/ec-class-fee-schedule').send({
            academic_year: YEAR,
            cells: [
                { class_id: CLASS_AUG, fee_head_id: headId, campus_id: null, amount: 2000 },
                { class_id: CLASS_AUG, fee_head_id: headId, campus_id: CAMPUS_A, amount: 2500 },
                { class_id: CLASS_APR, fee_head_id: headId, campus_id: null, amount: 3000 },
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ saved: 3, cleared: 0 });

        const cleared = await manager.put('/ec-class-fee-schedule').send({
            academic_year: YEAR,
            cells: [{ class_id: CLASS_APR, fee_head_id: headId, campus_id: null, amount: null }],
        });
        expect(cleared.body.data).toEqual({ saved: 0, cleared: 1 });
        expect(await prisma.ec_class_fee_schedule.count()).toBe(2);
    });

    it('never stores two all-campus rows for the same cell', async () => {
        for (const amount of [2100, 2200]) {
            await manager.put('/ec-class-fee-schedule').send({ academic_year: '2026-27', cells: [{ class_id: CLASS_AUG, fee_head_id: headId, campus_id: null, amount }] });
        }
        const rows = await prisma.ec_class_fee_schedule.findMany({ where: { class_id: CLASS_AUG, fee_head_id: headId, campus_id: null } });
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].amount)).toBe(2200);
        expect(rows[0].academic_year).toBe(YEAR);
    });

    it('holds a campus-scoped user to their own campus rows', async () => {
        await manager.put('/ec-class-fee-schedule').send({ academic_year: YEAR, cells: [{ class_id: CLASS_AUG, fee_head_id: headId, campus_id: CAMPUS_B, amount: 2700 }] });

        const seen = await campusClerk.get(`/ec-class-fee-schedule?academic_year=${YEAR}`);
        expect(seen.status).toBe(200);
        expect(seen.body.data.map((r: any) => r.campus_id).sort()).toEqual([CAMPUS_A, null].sort());

        const allCampus = await campusClerk.put('/ec-class-fee-schedule').send({ academic_year: YEAR, cells: [{ class_id: CLASS_AUG, fee_head_id: headId, campus_id: null, amount: 1 }] });
        expect(allCampus.status).toBe(403);
        const otherCampus = await campusClerk.put('/ec-class-fee-schedule').send({ academic_year: YEAR, cells: [{ class_id: CLASS_AUG, fee_head_id: headId, campus_id: CAMPUS_B, amount: 1 }] });
        expect(otherCampus.status).toBe(403);
        const own = await campusClerk.put('/ec-class-fee-schedule').send({ academic_year: YEAR, cells: [{ class_id: CLASS_AUG, fee_head_id: headId, campus_id: CAMPUS_A, amount: 2600 }] });
        expect(own.status).toBe(200);

        const bRow = await prisma.ec_class_fee_schedule.findFirstOrThrow({ where: { campus_id: CAMPUS_B } });
        expect((await campusClerk.delete(`/ec-class-fee-schedule/${bRow.id}`)).status).toBe(404);
    });

    it('refuses amounts that are not whole rupees of at least 1', async () => {
        for (const amount of [0, 12.5, -5]) {
            const res = await manager.put('/ec-class-fee-schedule').send({ academic_year: YEAR, cells: [{ class_id: CLASS_AUG, fee_head_id: headId, campus_id: null, amount }] });
            expect(res.status).toBe(400);
        }
    });

    it('copies a year, keeping amounts already set unless told to replace them', async () => {
        await manager.put('/ec-class-fee-schedule').send({ academic_year: NEXT_YEAR, cells: [{ class_id: CLASS_AUG, fee_head_id: headId, campus_id: null, amount: 9999 }] });

        const keep = await manager.post('/ec-class-fee-schedule/copy-year').send({ from_year: YEAR, to_year: NEXT_YEAR });
        expect(keep.status).toBe(200);
        expect(keep.body.data).toMatchObject({ created: 2, updated: 0, kept: 1 });

        const replace = await manager.post('/ec-class-fee-schedule/copy-year').send({ from_year: YEAR, to_year: NEXT_YEAR, overwrite: true });
        expect(replace.body.data).toMatchObject({ created: 0, updated: 1, kept: 2 });
        const allCampus = await prisma.ec_class_fee_schedule.findFirstOrThrow({ where: { academic_year: NEXT_YEAR, campus_id: null } });
        expect(Number(allCampus.amount)).toBe(2200);

        // A campus-scoped user copies only their own campus.
        const scoped = await campusClerk.post('/ec-class-fee-schedule/copy-year').send({ from_year: YEAR, to_year: '2028-2029' });
        expect(scoped.body.data).toMatchObject({ created: 1 });
        const copied = await prisma.ec_class_fee_schedule.findMany({ where: { academic_year: '2028-2029' } });
        expect(copied.map((r) => r.campus_id)).toEqual([CAMPUS_A]);
    });

    it('lets a viewer read but not change class amounts', async () => {
        expect((await viewer.get(`/ec-class-fee-schedule?academic_year=${YEAR}`)).status).toBe(200);
        expect((await viewer.put('/ec-class-fee-schedule').send({ academic_year: YEAR, cells: [{ class_id: CLASS_AUG, fee_head_id: headId, campus_id: null, amount: 5 }] })).status).toBe(403);
        expect((await academicClerk.get(`/ec-class-fee-schedule?academic_year=${YEAR}`)).status).toBe(403);
    });
});

describe('separation from academic fees', () => {
    it('left every academic table exactly as it was', async () => {
        expect(await academicSnapshot(prisma)).toEqual(before);
    });
});
