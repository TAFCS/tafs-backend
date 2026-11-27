/**
 * TAFSD-605 phase 4: extracurricular payments over HTTP through the real
 * guards. Partial and full payments, over-payment, the paid-on date window,
 * descending-order reversal (recompute, never subtract), the frozen receipt,
 * expiry → reissue → delete-the-reissue, waive / unwaive, and every money
 * identity checked after every step.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { STUDENT, YEAR, seedSchool } from './helpers/fixtures';
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
let kit: number;

const today = todayPktKey();
const plus = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const asDate = (key: string) => new Date(`${key}T00:00:00Z`);
const invariantsHold = async () => expect(await ecInvariantProblems(prisma as any)).toEqual([]);

beforeAll(async () => {
    let jwt: JwtService;
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    await seedEcUsers(prisma);
    manager = client(app, tokenFor(jwt, EC_USERS.ecManager));
    campusClerk = client(app, tokenFor(jwt, EC_USERS.ecClerk));
    viewer = client(app, tokenFor(jwt, EC_USERS.ecViewer));
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
});

afterAll(async () => {
    await app?.close();
});

const issue = async (cc: number, months: number[], body: object = {}) => {
    const ids = (await prisma.ec_student_charges.findMany({ where: { student_id: cc, target_month: { in: months }, current_voucher_id: null }, orderBy: { id: 'asc' } })).map((c) => c.id);
    const res = await manager.post('/ec-vouchers').send({ student_id: cc, charge_ids: ids, issue_date: today, ...body });
    expect(res.status).toBe(201);
    return res.body.data;
};
const pay = (voucherId: number, amount: number, extra: object = {}) =>
    manager.post('/ec-deposits').send({ voucher_id: voucherId, amount, allocation: 'AUTO', payment_method: 'cash', ...extra });

describe('payments on one voucher', () => {
    let v1: any;
    let firstDeposit: number;
    let secondDeposit: number;

    beforeAll(async () => {
        v1 = await issue(STUDENT.A1, [9]); // club Sep 2,500 + kit 4,500 = 7,000
    });

    it('takes a partial payment, filling lines in order', async () => {
        const res = await pay(v1.id, 3000, { reference_number: 'R-1' });
        expect(res.status).toBe(201);
        firstDeposit = res.body.data.deposit_id;
        expect(res.body.data.voucher).toMatchObject({ state: 'PARTIALLY_PAID', amount_paid: 3000, balance: 4000 });
        expect(res.body.data.voucher.lines.map((l: any) => [l.amount_paid, l.remaining])).toEqual([
            [2500, 0],
            [500, 4000],
        ]);
        const clubSep = await prisma.ec_student_charges.findFirstOrThrow({ where: { student_id: STUDENT.A1, fee_head_id: club, target_month: 9 } });
        expect(clubSep.status).toBe('PAID');
        await invariantsHold();
    });

    it('refuses more than the balance, a wrong manual split, a future or pre-issue date', async () => {
        expect((await pay(v1.id, 4001)).status).toBe(400);
        const kitLine = v1.lines.find((l: any) => l.fee_head_id === kit);
        expect((await pay(v1.id, 1000, { allocation: 'MANUAL', lines: [{ line_id: kitLine.id, amount: 900 }] })).status).toBe(400);
        expect((await pay(v1.id, 100, { deposit_date: plus(1) })).status).toBe(400);
        expect((await pay(v1.id, 100, { deposit_date: plus(-1) })).status).toBe(400);
        expect((await pay(v1.id, 100, { payment_method: 'family_credit' })).status).toBe(400);
        expect((await pay(v1.id, 100, { payment_method: 'meezan' })).status).toBe(400);
        await invariantsHold();
    });

    it('pays the rest by a manual split, then freezes the stamped receipt', async () => {
        const kitLine = v1.lines.find((l: any) => l.fee_head_id === kit);
        const res = await pay(v1.id, 4000, { allocation: 'MANUAL', lines: [{ line_id: kitLine.id, amount: 4000 }], payment_method: 'cheque', bank_name: 'Test Bank' });
        expect(res.status).toBe(201);
        secondDeposit = res.body.data.deposit_id;
        expect(res.body.data.voucher).toMatchObject({ state: 'PAID', balance: 0 });

        const pdf = await manager.post(`/ec-vouchers/${v1.id}/pdf`);
        expect(pdf.body.data.url).toMatch(/_paid\.pdf$/);
        expect((await prisma.ec_vouchers.findUniqueOrThrow({ where: { id: v1.id } })).paid_pdf_url).toBe(pdf.body.data.url);
        // Asking again returns the same frozen file.
        expect((await manager.post(`/ec-vouchers/${v1.id}/pdf`)).body.data.url).toBe(pdf.body.data.url);

        expect((await pay(v1.id, 1)).status).toBe(409);
        await invariantsHold();
    });

    it('reverses only the latest payment, recomputing everything and clearing the receipt', async () => {
        expect((await manager.post(`/ec-deposits/${firstDeposit}/reverse`).send({ reason: 'wrong voucher' })).status).toBe(409);
        expect((await manager.post(`/ec-deposits/${secondDeposit}/reverse`).send({ reason: '' })).status).toBe(400);

        const res = await manager.post(`/ec-deposits/${secondDeposit}/reverse`).send({ reason: 'Cheque bounced' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ state: 'PARTIALLY_PAID', amount_paid: 3000, balance: 4000 });
        const v = await prisma.ec_vouchers.findUniqueOrThrow({ where: { id: v1.id } });
        expect(v.paid_pdf_url).toBeNull();
        const audit = await prisma.audit_logs.findFirst({ where: { entity_type: 'EC_DEPOSIT', entity_id: String(secondDeposit), action: 'DELETED' } });
        expect(audit?.note).toContain('Cheque bounced');
        expect(JSON.parse(audit!.old_value!)).toMatchObject({ amount: 4000, method: 'cheque' });
        await invariantsHold();
    });

    it('cannot be deleted while it has payments', async () => {
        expect((await manager.delete(`/ec-vouchers/${v1.id}`)).status).toBe(409);
    });

    it('waives the rest (WAIVED even though part was paid), and undoes it', async () => {
        expect((await manager.post(`/ec-vouchers/${v1.id}/waive`).send({ reason: 'x' })).status).toBe(400);
        const res = await manager.post(`/ec-vouchers/${v1.id}/waive`).send({ reason: 'Hardship, approved by principal' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ state: 'WAIVED', amount_paid: 3000, amount_waived: 4000, balance: 0 });
        const kitCharge = await prisma.ec_student_charges.findFirstOrThrow({ where: { student_id: STUDENT.A1, fee_head_id: kit } });
        expect(kitCharge).toMatchObject({ status: 'WAIVED' });
        await invariantsHold();

        expect((await pay(v1.id, 100)).status).toBe(409);
        expect((await manager.post(`/ec-deposits/${firstDeposit}/reverse`).send({ reason: 'test' })).status).toBe(409);
        expect((await manager.post(`/ec-vouchers/${v1.id}/waive`).send({ reason: 'again please' })).status).toBe(409);

        const undo = await manager.post(`/ec-vouchers/${v1.id}/unwaive`);
        expect(undo.body.data).toMatchObject({ state: 'PARTIALLY_PAID', amount_waived: 0, balance: 4000 });
        await invariantsHold();
    });
});

describe('expiry and reissue', () => {
    let v2: any;
    let v3: any;

    it('takes a payment dated up to the valid-till day, and refuses one after it', async () => {
        v2 = await issue(STUDENT.A1, [10]); // club Oct 2,500
        await prisma.ec_vouchers.update({ where: { id: v2.id }, data: { issue_date: asDate(plus(-20)), expiry_date: asDate(plus(-5)) } });
        expect((await manager.get(`/ec-vouchers/${v2.id}`)).body.data.state).toBe('EXPIRED');

        expect((await pay(v2.id, 1000)).status).toBe(409); // dated today, after expiry
        const onTime = await pay(v2.id, 1000, { deposit_date: plus(-5) }); // the expiry day itself
        expect(onTime.status).toBe(201);
        expect(onTime.body.data.voucher).toMatchObject({ state: 'EXPIRED', amount_paid: 1000, balance: 1500 });
        await invariantsHold();
    });

    it('refuses to reissue a voucher that has not expired', async () => {
        const live = await issue(STUDENT.A1, [11]);
        expect((await manager.post(`/ec-vouchers/${live.id}/reissue`).send({ issue_date: today })).status).toBe(409);
        expect((await manager.delete(`/ec-vouchers/${live.id}`)).status).toBe(200);
    });

    it("reissues an expired voucher's remainder; the old one becomes history", async () => {
        const res = await manager.post(`/ec-vouchers/${v2.id}/reissue`).send({ issue_date: today, expiry_date: plus(10) });
        expect(res.status).toBe(201);
        v3 = res.body.data;
        expect(v3).toMatchObject({ state: 'UNPAID', total_amount: 1500, reissued_from: { id: v2.id } });
        expect(v3.lines.map((l: any) => [l.description, l.amount])).toEqual([['SWIMMING CLUB (OCT 26)', 1500]]);

        const old = (await manager.get(`/ec-vouchers/${v2.id}`)).body.data;
        expect(old).toMatchObject({ state: 'REISSUED', reissued_to: { id: v3.id } });
        const oct = await prisma.ec_student_charges.findFirstOrThrow({ where: { student_id: STUDENT.A1, fee_head_id: club, target_month: 10 } });
        expect(oct).toMatchObject({ current_voucher_id: v3.id, status: 'PARTIALLY_PAID' });
        await invariantsHold();

        // The old voucher takes nothing more, and its payment can't be reversed while reissued.
        expect((await pay(v2.id, 100, { deposit_date: plus(-5) })).status).toBe(409);
        const oldDeposit = await prisma.ec_deposits.findFirstOrThrow({ where: { voucher_id: v2.id } });
        expect((await manager.post(`/ec-deposits/${oldDeposit.id}/reverse`).send({ reason: 'test' })).status).toBe(409);
        expect((await manager.post(`/ec-vouchers/${v2.id}/reissue`).send({ issue_date: today })).status).toBe(409);
        expect((await manager.post(`/ec-vouchers/${v2.id}/waive`).send({ reason: 'not allowed' })).status).toBe(409);
        expect((await manager.delete(`/ec-vouchers/${v2.id}`)).status).toBe(409);
    });

    it('deleting the reissue hands the charges back (lapsed again)', async () => {
        expect((await manager.delete(`/ec-vouchers/${v3.id}`)).status).toBe(200);
        const old = (await manager.get(`/ec-vouchers/${v2.id}`)).body.data;
        expect(old.state).toBe('EXPIRED');
        const oct = await prisma.ec_student_charges.findFirstOrThrow({ where: { student_id: STUDENT.A1, fee_head_id: club, target_month: 10 } });
        expect(oct.current_voucher_id).toBe(v2.id);
        await invariantsHold();

        const summary = (await manager.get(`/ec-vouchers/student/${STUDENT.A1}`)).body.data.stats;
        expect(summary.lapsed_balance).toBe(1500);
    });

    it('pays the reissue in full', async () => {
        const again = await manager.post(`/ec-vouchers/${v2.id}/reissue`).send({ issue_date: today });
        expect(again.status).toBe(201);
        const paid = await pay(again.body.data.id, 1500);
        expect(paid.body.data.voucher.state).toBe('PAID');
        const oct = await prisma.ec_student_charges.findFirstOrThrow({ where: { student_id: STUDENT.A1, fee_head_id: club, target_month: 10 } });
        expect(oct).toMatchObject({ status: 'PAID', amount_paid: expect.anything() });
        expect(Number(oct.amount_paid)).toBe(2500);
        await invariantsHold();
    });
});

describe('access and scope on payments', () => {
    it('needs the record and reverse actions, and hides other campuses', async () => {
        const bVoucher = await issue(STUDENT.B1, [9]);
        expect((await viewer.post('/ec-deposits').send({ voucher_id: bVoucher.id, amount: 100, allocation: 'AUTO', payment_method: 'cash' })).status).toBe(403);
        expect((await campusClerk.post('/ec-deposits').send({ voucher_id: bVoucher.id, amount: 100, allocation: 'AUTO', payment_method: 'cash' })).status).toBe(404);
        const d = await pay(bVoucher.id, 100);
        expect((await viewer.post(`/ec-deposits/${d.body.data.deposit_id}/reverse`).send({ reason: 'test it' })).status).toBe(403);
        expect((await campusClerk.post(`/ec-deposits/${d.body.data.deposit_id}/reverse`).send({ reason: 'test it' })).status).toBe(404);
        expect((await campusClerk.post(`/ec-vouchers/${bVoucher.id}/waive`).send({ reason: 'test it' })).status).toBe(404);
        await invariantsHold();
    });
});

describe('separation from academic fees', () => {
    it('left every academic table exactly as it was', async () => {
        expect(await academicSnapshot(prisma)).toEqual(before);
    });
});
