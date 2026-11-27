/**
 * TAFSD-605 phase 3: extracurricular vouchers over HTTP through the real
 * guards. Issuing (one voucher per call, one academic year, never touching
 * another voucher: no arrears, no voiding), the list, search and states, the
 * challan endpoint, delete, scope, and "academic tables untouched".
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, CLASS_AUG, STUDENT, USERS, YEAR, seedSchool } from './helpers/fixtures';
import { EC_USERS, academicSnapshot, seedEcUsers } from './helpers/ec-fixtures';
import { todayPktKey } from '../../src/modules/extracurricular/ec-dates.util';

let app: INestApplication;
let prisma: PrismaService;
let manager: ReturnType<typeof client>;
let campusClerk: ReturnType<typeof client>;
let viewer: ReturnType<typeof client>;
let academicClerk: ReturnType<typeof client>;
let before: Awaited<ReturnType<typeof academicSnapshot>>;
let club: number;
let kit: number;

const today = todayPktKey();
const plus = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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

    club = (await manager.post('/ec-fee-heads').send({ name: 'Swimming Club', frequency: 'MONTHLY', months: [9, 10, 11] })).body.data.id;
    kit = (await manager.post('/ec-fee-heads').send({ name: 'Scouts Kit', frequency: 'ONE_TIME', months: [9] })).body.data.id;
    for (const cc of [STUDENT.A1, STUDENT.B1]) {
        await manager.post(`/ec-student-charges/student/${cc}/save`).send({
            academic_year: YEAR,
            cells: [
                { fee_head_id: club, target_month: 9, amount: 2500 },
                { fee_head_id: club, target_month: 10, amount: 2500 },
                { fee_head_id: club, target_month: 11, amount: 2500 },
                { fee_head_id: kit, target_month: 9, amount: 4500 },
            ],
        });
    }
    // A charge in another academic year, to prove one voucher holds one year.
    await manager.post(`/ec-student-charges/student/${STUDENT.A1}/save`).send({ academic_year: '2027-2028', cells: [{ fee_head_id: kit, target_month: 9, amount: 4600 }] });
});

afterAll(async () => {
    await app?.close();
});

const chargeIds = async (cc: number, where: object = {}) =>
    (await prisma.ec_student_charges.findMany({ where: { student_id: cc, academic_year: YEAR, ...where }, orderBy: { id: 'asc' } })).map((c) => c.id);

describe('issuing extracurricular vouchers', () => {
    let first: any;

    it('lists what can be issued, and nothing open yet', async () => {
        const res = await manager.get(`/ec-vouchers/issuable?student_id=${STUDENT.A1}`);
        expect(res.status).toBe(200);
        expect(res.body.data.charges).toHaveLength(5);
        expect(res.body.data.open_vouchers).toEqual([]);
    });

    it('issues one voucher: EC number, lines in order, charges moved onto it', async () => {
        const sep = await chargeIds(STUDENT.A1, { target_month: 9 });
        const res = await manager.post('/ec-vouchers').send({ student_id: STUDENT.A1, charge_ids: sep, issue_date: today, expiry_date: plus(15), bank_account_id: 1 });
        expect(res.status).toBe(201);
        first = res.body.data;
        expect(first.voucher_number).toMatch(/^EC\d{10,}$/);
        expect(first).toMatchObject({ state: 'UNPAID', total_amount: 7000, amount_paid: 0, balance: 7000, academic_year: YEAR, campus_id: CAMPUS_A, class_id: CLASS_AUG });
        expect(first.lines.map((l: any) => [l.description, l.amount])).toEqual([
            ['SWIMMING CLUB (SEP 26)', 2500],
            ['SCOUTS KIT (SEP 26)', 4500],
        ]);
        const charges = await prisma.ec_student_charges.findMany({ where: { id: { in: sep } } });
        expect(charges.every((c) => c.current_voucher_id === first.id && c.status === 'ISSUED')).toBe(true);
        const v = await prisma.ec_vouchers.findUniqueOrThrow({ where: { id: first.id } });
        expect(v.bank_snapshot).toMatchObject({ id: 1, name: 'Test Bank', account: '0000-TEST' });
    });

    it('refuses a charge already on a voucher, two academic years at once, and bad dates', async () => {
        const sep = await chargeIds(STUDENT.A1, { target_month: 9 });
        expect((await manager.post('/ec-vouchers').send({ student_id: STUDENT.A1, charge_ids: sep, issue_date: today })).status).toBe(409);

        const oct = await chargeIds(STUDENT.A1, { target_month: 10 });
        const nextYear = (await prisma.ec_student_charges.findFirstOrThrow({ where: { student_id: STUDENT.A1, academic_year: '2027-2028' } })).id;
        expect((await manager.post('/ec-vouchers').send({ student_id: STUDENT.A1, charge_ids: [...oct, nextYear], issue_date: today })).status).toBe(400);
        expect((await manager.post('/ec-vouchers').send({ student_id: STUDENT.A1, charge_ids: oct, issue_date: today, expiry_date: plus(-1) })).status).toBe(400);
        expect((await manager.post('/ec-vouchers').send({ student_id: STUDENT.A1, charge_ids: oct, issue_date: plus(5), expiry_date: plus(2) })).status).toBe(400);
        // Someone else's charge.
        const bOct = await chargeIds(STUDENT.B1, { target_month: 10 });
        expect((await manager.post('/ec-vouchers').send({ student_id: STUDENT.A1, charge_ids: bOct, issue_date: today })).status).toBe(400);
    });

    it('issues a second voucher without touching the first (no arrears, no voiding)', async () => {
        const firstBefore = await prisma.ec_vouchers.findUniqueOrThrow({ where: { id: first.id }, include: { ec_voucher_lines: true } });
        const oct = await chargeIds(STUDENT.A1, { target_month: 10 });
        const res = await manager.post('/ec-vouchers').send({ student_id: STUDENT.A1, charge_ids: oct, issue_date: today });
        expect(res.status).toBe(201);
        expect(res.body.data.total_amount).toBe(2500);
        // Default validity: 15 days.
        expect(res.body.data.expiry_date).toBe(plus(15));

        const firstAfter = await prisma.ec_vouchers.findUniqueOrThrow({ where: { id: first.id }, include: { ec_voucher_lines: true } });
        expect(firstAfter).toEqual(firstBefore);

        const issuable = await manager.get(`/ec-vouchers/issuable?student_id=${STUDENT.A1}`);
        expect(issuable.body.data.open_vouchers.map((v: any) => v.id).sort()).toEqual([first.id, res.body.data.id].sort());
    });

    it('lists with multi-value filters, states and a server-side search', async () => {
        const all = await manager.get('/ec-vouchers');
        expect(all.status).toBe(200);
        expect(all.body.data.meta.total).toBe(2);
        expect(all.body.data.summary).toMatchObject({ total_amount: 9500, amount_paid: 0, balance: 9500 });

        expect((await manager.get(`/ec-vouchers?fee_head_ids=${kit}`)).body.data.meta.total).toBe(1);
        expect((await manager.get('/ec-vouchers?states=PAID,WAIVED')).body.data.meta.total).toBe(0);
        expect((await manager.get('/ec-vouchers?states=UNPAID')).body.data.meta.total).toBe(2);

        expect((await manager.get('/ec-vouchers/search-simple?q=')).body.data).toEqual([]);
        const byNumber = await manager.get(`/ec-vouchers/search-simple?q=${first.voucher_number.toLowerCase()}`);
        expect(byNumber.body.data.map((h: any) => h.id)).toContain(first.id);
        const byStudent = await manager.get(`/ec-vouchers/search-simple?q=${STUDENT.A1}`);
        expect(byStudent.body.data).toHaveLength(2);
        expect(Object.keys(byStudent.body.data[0]).sort()).toEqual(['balance', 'class_name', 'expiry_date', 'full_name', 'gr_number', 'id', 'state', 'student_id', 'voucher_number'].sort());
    });

    it('derives EXPIRED from the date, without any job', async () => {
        await prisma.ec_vouchers.update({ where: { id: first.id }, data: { expiry_date: new Date(`${plus(-1)}T00:00:00Z`) } });
        expect((await manager.get(`/ec-vouchers/${first.id}`)).body.data.state).toBe('EXPIRED');
        expect((await manager.get('/ec-vouchers?states=EXPIRED')).body.data.meta.total).toBe(1);
        await prisma.ec_vouchers.update({ where: { id: first.id }, data: { expiry_date: new Date(`${plus(15)}T00:00:00Z`) } });
    });

    it('serves the challan and a student summary', async () => {
        const pdf = await manager.post(`/ec-vouchers/${first.id}/pdf`);
        expect(pdf.status).toBe(200);
        expect(pdf.body.data.filename).toBe(`GR-${STUDENT.A1}_${first.voucher_number}.pdf`);
        const v = await prisma.ec_vouchers.findUniqueOrThrow({ where: { id: first.id } });
        expect(v.pdf_hash).toMatch(/^[0-9a-f]{64}$/);

        const summary = await manager.get(`/ec-vouchers/student/${STUDENT.A1}`);
        // Unissued counts every year: November 2026 (2,500) and the 2027-2028 kit (4,600).
        expect(summary.body.data.stats).toMatchObject({ billed: 9500, received: 0, open_balance: 9500, lapsed_balance: 0, unissued: 7100 });
    });

    it('deletes a voucher with no payments, putting its charges back', async () => {
        const second = (await prisma.ec_vouchers.findFirstOrThrow({ where: { id: { not: first.id } } })).id;
        expect((await viewer.delete(`/ec-vouchers/${second}`)).status).toBe(403);
        expect((await manager.delete(`/ec-vouchers/${second}`)).status).toBe(200);
        expect(await prisma.ec_vouchers.findUnique({ where: { id: second } })).toBeNull();
        const oct = await prisma.ec_student_charges.findFirstOrThrow({ where: { student_id: STUDENT.A1, academic_year: YEAR, target_month: 10 } });
        expect(oct).toMatchObject({ current_voucher_id: null, status: 'NOT_ISSUED' });
    });

    it('keeps vouchers outside scope out of reach and checks every action', async () => {
        const bSep = await chargeIds(STUDENT.B1, { target_month: 9 });
        const b = await manager.post('/ec-vouchers').send({ student_id: STUDENT.B1, charge_ids: bSep, issue_date: today });
        expect(b.status).toBe(201);

        expect((await campusClerk.get(`/ec-vouchers/${b.body.data.id}`)).status).toBe(404);
        expect((await campusClerk.post(`/ec-vouchers/${b.body.data.id}/pdf`)).status).toBe(404);
        expect((await campusClerk.delete(`/ec-vouchers/${b.body.data.id}`)).status).toBe(404);
        expect((await campusClerk.get('/ec-vouchers')).body.data.items.map((v: any) => v.student.cc)).toEqual([STUDENT.A1]);
        expect((await campusClerk.get(`/ec-vouchers/issuable?student_id=${STUDENT.B1}`)).status).toBe(404);

        expect((await viewer.post('/ec-vouchers').send({ student_id: STUDENT.A1, charge_ids: [1], issue_date: today })).status).toBe(403);
        expect((await academicClerk.get('/ec-vouchers')).status).toBe(403);
    });
});

describe('separation from academic fees', () => {
    it('left every academic table exactly as it was', async () => {
        expect(await academicSnapshot(prisma)).toEqual(before);
    });
});
