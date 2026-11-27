/**
 * TAFSD-605 phase 6: extracurricular reports over HTTP. One scenario covers
 * every bucket (paid, part-paid, lapsed, waived, not yet issued) and checks:
 * charged = received + waived + not issued + outstanding + lapsed, per head and
 * in total; the outstanding/lapsed split; payments by method and head; scope;
 * and the export actions.
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
let kit: number;

const today = todayPktKey();
const plus = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const issueFor = async (cc: number, where: object) => {
    const ids = (await prisma.ec_student_charges.findMany({ where: { student_id: cc, ...where }, orderBy: { id: 'asc' } })).map((c) => c.id);
    return (await manager.post('/ec-vouchers').send({ student_id: cc, charge_ids: ids, issue_date: today })).body.data;
};

beforeAll(async () => {
    let jwt: JwtService;
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    await seedEcUsers(prisma);
    manager = client(app, tokenFor(jwt, EC_USERS.ecManager));
    campusClerk = client(app, tokenFor(jwt, EC_USERS.ecClerk));
    viewer = client(app, tokenFor(jwt, EC_USERS.ecViewer));
    before = await academicSnapshot(prisma);

    club = (await manager.post('/ec-fee-heads').send({ name: 'Swimming Club', frequency: 'MONTHLY', months: [9, 10, 11], sort_order: 1 })).body.data.id;
    kit = (await manager.post('/ec-fee-heads').send({ name: 'Scouts Kit', frequency: 'ONE_TIME', months: [9], sort_order: 2 })).body.data.id;
    await manager.post('/ec-student-charges/bulk-assign').send({ fee_head_id: club, academic_year: YEAR, amount_source: 'CUSTOM', amount: 2000, class_ids: [CLASS_AUG] });
    await manager.post('/ec-student-charges/bulk-assign').send({ fee_head_id: kit, academic_year: YEAR, amount_source: 'CUSTOM', amount: 4500, student_ids: [STUDENT.A1] });

    // A1: Sep club + kit (6,500), 3,000 paid in cash → club paid, kit 1,000 paid.
    const v1 = await issueFor(STUDENT.A1, { target_month: 9 });
    await manager.post('/ec-deposits').send({ voucher_id: v1.id, amount: 3000, allocation: 'AUTO', payment_method: 'cash' });

    // A2: Sep club (2,000), 500 paid by transfer before it expired → 1,500 lapsed.
    const v2 = await issueFor(STUDENT.A2, { target_month: 9 });
    await prisma.ec_vouchers.update({ where: { id: v2.id }, data: { issue_date: new Date(`${plus(-20)}T00:00:00Z`), expiry_date: new Date(`${plus(-3)}T00:00:00Z`) } });
    await manager.post('/ec-deposits').send({ voucher_id: v2.id, amount: 500, allocation: 'AUTO', payment_method: 'bank_transfer', deposit_date: plus(-4) });

    // B1: Sep club (2,000) waived.
    const v3 = await issueFor(STUDENT.B1, { target_month: 9 });
    await manager.post(`/ec-vouchers/${v3.id}/waive`).send({ reason: 'Sports scholarship' });

    expect(await ecInvariantProblems(prisma as any)).toEqual([]);
});

afterAll(async () => {
    await app?.close();
});

describe('extracurricular reports', () => {
    it('summary: every rupee charged is received, waived, not issued, outstanding or lapsed', async () => {
        const res = await manager.get(`/ec-reports/summary?academic_years=${YEAR}`);
        expect(res.status).toBe(200);
        const { rows, totals } = res.body.data;
        const swim = rows.find((r: any) => r.fee_head_id === club);
        const scouts = rows.find((r: any) => r.fee_head_id === kit);
        expect(swim).toMatchObject({ students: 3, charged: 18000, received: 2500, waived: 2000, not_issued: 12000, outstanding: 0, lapsed: 1500, balanced: true });
        expect(scouts).toMatchObject({ students: 1, charged: 4500, received: 1000, waived: 0, not_issued: 0, outstanding: 3500, lapsed: 0, balanced: true });
        expect(totals).toMatchObject({ charged: 22500, received: 3500, waived: 2000, not_issued: 12000, outstanding: 3500, lapsed: 1500, balanced: true });
    });

    it('summary follows scope: a campus-A user never sees campus B', async () => {
        const res = await campusClerk.get('/ec-reports/summary');
        const swim = res.body.data.rows.find((r: any) => r.fee_head_id === club);
        expect(swim).toMatchObject({ students: 2, charged: 12000, waived: 0, balanced: true });
    });

    it('outstanding: open and lapsed vouchers, waived and paid left out', async () => {
        const res = await manager.get('/ec-reports/outstanding');
        expect(res.status).toBe(200);
        expect(res.body.data.items.map((v: any) => [v.student.cc, v.state]).sort()).toEqual(
            [
                [STUDENT.A1, 'PARTIALLY_PAID'],
                [STUDENT.A2, 'EXPIRED'],
            ].sort(),
        );
        expect(res.body.data.summary).toMatchObject({ open_count: 1, open_balance: 3500, lapsed_count: 1, lapsed_balance: 1500 });
        expect((await manager.get('/ec-reports/outstanding?states=EXPIRED')).body.data.meta.total).toBe(1);
    });

    it('payments: totals by method and by head, with a server-side search', async () => {
        const res = await manager.get('/ec-reports/payments');
        expect(res.status).toBe(200);
        expect(res.body.data.summary.amount).toBe(3500);
        expect(res.body.data.summary.by_method).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ payment_method: 'cash', amount: 3000 }),
                expect.objectContaining({ payment_method: 'bank_transfer', amount: 500 }),
            ]),
        );
        expect(res.body.data.summary.by_head).toEqual(
            expect.arrayContaining([expect.objectContaining({ fee_head_id: club, amount: 2500 }), expect.objectContaining({ fee_head_id: kit, amount: 1000 })]),
        );
        expect((await manager.get('/ec-reports/payments?payment_methods=bank_transfer')).body.data.summary.amount).toBe(500);
        expect((await manager.get(`/ec-reports/payments?q=${STUDENT.A1}`)).body.data.meta.total).toBe(1);
        expect((await manager.get(`/ec-reports/payments?date_from=${plus(-1)}`)).body.data.summary.amount).toBe(3000);
    });

    it('exports need their own action', async () => {
        const xlsx = await manager.get('/ec-reports/summary/export');
        expect(xlsx.status).toBe(200);
        expect(xlsx.headers['content-type']).toContain('spreadsheetml');
        expect((await manager.get('/ec-reports/payments/export')).status).toBe(200);
        expect((await manager.get('/ec-reports/outstanding/export')).status).toBe(200);
        expect((await viewer.get('/ec-reports/summary')).status).toBe(200);
        expect((await viewer.get('/ec-reports/summary/export')).status).toBe(403);
    });

    it('left every academic table exactly as it was', async () => {
        expect(await academicSnapshot(prisma)).toEqual(before);
    });
});
