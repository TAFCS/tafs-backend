/**
 * TAFSD-547: a bulk voucher job can hold back students who owe arrears, report
 * them, and a follow-up job issues them later. End to end over HTTP against the
 * throwaway database: the real job pipeline runs and calls the real
 * VouchersService.create() for every voucher it issues.
 *
 * School: A1 and A2 (campus A) and B1 (campus B), all in the Aug-Jul class.
 * Each has an August and a September tuition head. August is billed first:
 *   - A1 and B1: August issued by a bulk job and left unpaid -> arrears.
 *   - A2: August already paid -> no arrears.
 * The job under test bills September.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { Prisma, StaffRole } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, CAMPUS_B, FEE, STUDENT, USERS, YEAR, seedSchool, type SeededUser } from './helpers/fixtures';

const MTF = 18995;
const AUG = '2026-08-01';
const SEP = '2026-09-01';

/** Finance clerk with the Bulk Voucher tile in full, scoped to campus A. */
const BULK_CLERK: SeededUser = { id: 'db-suite-bulk', username: 'dbsuite.bulk', role: StaffRole.FINANCE_CLERK };

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let admin: ReturnType<typeof client>;
let bulkClerk: ReturnType<typeof client>;

const FINISHED = ['DONE', 'PARTIAL_FAILURE', 'FAILED', 'INTERRUPTED'];

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);

    await prisma.users.create({
        data: { id: BULK_CLERK.id, username: BULK_CLERK.username, full_name: BULK_CLERK.username, role: BULK_CLERK.role, password_hash: 'x', is_active: true },
    });
    const perm = await prisma.permissions.upsert({
        where: { key: 'finance.vouchers.generate_bulk' },
        update: {},
        create: { key: 'finance.vouchers.generate_bulk', module: 'finance', description: 'bulk' },
    });
    await prisma.user_tile_grants.create({
        data: { user_id: BULK_CLERK.id, tile_id: 'finance.bulk_voucher', allow: true, granted_by: USERS.admin.id },
    });
    await prisma.user_permissions.create({
        data: { user_id: BULK_CLERK.id, permission_id: perm.id, granted: true, granted_by: USERS.admin.id },
    });
    await prisma.user_scope_entries.create({ data: { user_id: BULK_CLERK.id, dimension: 'CAMPUS', ref_id: CAMPUS_A } });

    admin = client(app, tokenFor(jwt, USERS.admin));
    bulkClerk = client(app, tokenFor(jwt, BULK_CLERK));
});

afterAll(async () => {
    await app?.close();
});

beforeEach(async () => {
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "audit_logs", "deposit_allocations", "deposits", "voucher_arrear_surcharges", "voucher_heads", ' +
        '"vouchers", "bulk_voucher_jobs", "student_fees" RESTART IDENTITY CASCADE',
    );
    for (const cc of [STUDENT.A1, STUDENT.A2, STUDENT.B1]) {
        for (const [feeDate, month] of [[AUG, 8], [SEP, 9]] as const) {
            await prisma.student_fees.create({
                data: {
                    student_id: cc,
                    fee_type_id: FEE.MTF,
                    academic_year: YEAR,
                    target_month: month,
                    month,
                    fee_date: new Date(feeDate),
                    amount_before_discount: new Prisma.Decimal(MTF),
                    amount: new Prisma.Decimal(MTF),
                    term_start_month: 8,
                },
            });
        }
    }
    // A2 paid August in full (no voucher needed for the arrears read).
    await prisma.student_fees.updateMany({
        where: { student_id: STUDENT.A2, fee_date: new Date(AUG) },
        data: { status: 'PAID', amount_paid: new Prisma.Decimal(MTF) },
    });
    // A1 and B1: August billed by an ordinary bulk job and left unpaid.
    await runJob(admin, jobBody(AUG, [STUDENT.A1, STUDENT.B1], { due_date: '2026-08-10' }));
});

function jobBody(feeDate: string, ccs: number[], extra: Record<string, unknown> = {}) {
    const end = feeDate.slice(0, 8) + '28';
    return {
        fee_date_from: feeDate,
        fee_date_to: end,
        issue_date: feeDate,
        due_date: feeDate.slice(0, 8) + '10',
        bank_account_id: 1,
        send_notification: false,
        student_ccs: ccs,
        ...extra,
    };
}

async function waitForJob(as: ReturnType<typeof client>, jobId: number) {
    for (let i = 0; i < 300; i++) {
        const res = await as.get(`/bulk-voucher-jobs/${jobId}/status`);
        expect(res.status).toBe(200);
        if (FINISHED.includes(res.body.data.status)) return res.body.data;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`job #${jobId} did not finish`);
}

async function runJob(as: ReturnType<typeof client>, body: Record<string, unknown>) {
    const res = await as.post('/bulk-voucher-jobs').send(body);
    expect(res.status).toBe(202);
    return waitForJob(as, res.body.data.job_id);
}

async function liveSepVouchers(cc: number) {
    return prisma.vouchers.findMany({
        where: { student_id: cc, fee_date: new Date(SEP), status: { notIn: ['VOID', 'EXPIRED'] } },
        include: { voucher_heads: true },
    });
}

/** A voucher as issuance left it, without ids and timestamps. */
async function issuedShape() {
    const vouchers = await prisma.vouchers.findMany({
        orderBy: [{ student_id: 'asc' }, { fee_date: 'asc' }, { id: 'asc' }],
        include: { voucher_heads: { orderBy: { student_fee_id: 'asc' } }, voucher_arrear_surcharges: true },
    });
    return vouchers.map((v) => ({
        student_id: v.student_id,
        fee_date: v.fee_date?.toISOString(),
        status: v.status,
        due_date: v.due_date.toISOString(),
        validity_date: v.validity_date?.toISOString() ?? null,
        total_payable_before_due: String(v.total_payable_before_due),
        total_payable_after_due: String(v.total_payable_after_due),
        total_arrears: String(v.total_arrears),
        pay_immediately: v.pay_immediately,
        heads: v.voucher_heads.map((h) => ({ fee: h.student_fee_id, net: String(h.net_amount) })),
        surcharges: v.voucher_arrear_surcharges.length,
    }));
}

function reportShape(report: any[]) {
    return report.map((r) => ({ cc: r.cc, status: r.status, reason: r.reason ?? null }));
}

describe('bulk voucher job: hold back students with arrears (TAFSD-547)', () => {
    it('option on: a student with arrears is held back with the amount, the others are issued', async () => {
        const job = await runJob(admin, jobBody(SEP, [STUDENT.A1, STUDENT.A2], { hold_back_arrears: true }));

        expect(job.status).toBe('DONE');
        expect(job.hold_back_arrears).toBe(true);
        expect(job.success_count).toBe(1);
        expect(job.held_back_count).toBe(1);
        expect(job.fail_count).toBe(0);
        expect(job.held_back_item_count).toBe(1);

        // A2 (no arrears) got September; A1 (arrears) got nothing new.
        expect(await liveSepVouchers(STUDENT.A2)).toHaveLength(1);
        expect(await liveSepVouchers(STUDENT.A1)).toHaveLength(0);
        // A1's August voucher still stands, untouched (nothing superseded it).
        const a1Aug = await prisma.vouchers.findMany({ where: { student_id: STUDENT.A1, fee_date: new Date(AUG) } });
        expect(a1Aug.map((v) => v.status)).toEqual(['UNPAID']);
        const a1Sep = await prisma.student_fees.findFirstOrThrow({ where: { student_id: STUDENT.A1, fee_date: new Date(SEP) } });
        expect(a1Sep.status).toBe('NOT_ISSUED');

        const held = job.report.filter((r: any) => r.status === 'HELD_BACK_ARREARS');
        expect(held).toHaveLength(1);
        expect(held[0]).toMatchObject({
            cc: STUDENT.A1,
            student_name: 'Test Student One',
            arrears_amount: MTF,
            arrears_months: 1,
            oldest_unpaid_fee_date: AUG,
            arrears_as_of: SEP,
            class_name: 'Class VI',
            section_name: 'A',
            campus_id: CAMPUS_A,
            campus_name: 'Test Campus A',
            items_held: 1,
        });
        expect(job.report.find((r: any) => r.cc === STUDENT.A2)).toMatchObject({ status: 'SUCCESS' });
    });

    // Filled by the first "option off" test, compared by the second.
    let offBaseline: { shape: Awaited<ReturnType<typeof issuedShape>>; report: ReturnType<typeof reportShape>; success: number } | null = null;

    it('option off (not sent): both students issued, A1 with August carried as arrears, as before', async () => {
        const job = await runJob(admin, jobBody(SEP, [STUDENT.A1, STUDENT.A2]));

        expect(job.status).toBe('DONE');
        expect(job.success_count).toBe(2);
        expect(job.held_back_count).toBe(0);
        expect(job.hold_back_arrears).toBe(false);
        expect(job.report.every((r: any) => r.status !== 'HELD_BACK_ARREARS')).toBe(true);
        const shape = await issuedShape();
        const a1 = shape.find((v) => v.student_id === STUDENT.A1 && v.fee_date?.startsWith(SEP))!;
        expect(Number(a1.total_arrears)).toBe(MTF);
        expect(a1.heads).toHaveLength(2);
        // August was superseded by the September voucher.
        expect(shape.find((v) => v.student_id === STUDENT.A1 && v.fee_date?.startsWith(AUG))!.status).toBe('VOID');
        // An ordinary job writes none of the new columns.
        expect(await prisma.bulk_voucher_jobs.count({ where: { OR: [{ hold_back_arrears: true }, { source_job_id: { not: null } }] } })).toBe(0);

        offBaseline = { shape, report: reportShape(job.report), success: job.success_count };
    });

    it('option off (sent as false): byte-for-byte the same vouchers and report', async () => {
        expect(offBaseline).not.toBeNull();
        const job = await runJob(admin, jobBody(SEP, [STUDENT.A1, STUDENT.A2], { hold_back_arrears: false }));

        expect(job.success_count).toBe(offBaseline!.success);
        expect(reportShape(job.report)).toEqual(offBaseline!.report);
        expect(await issuedShape()).toEqual(offBaseline!.shape);
        expect(await prisma.bulk_voucher_jobs.count({ where: { OR: [{ hold_back_arrears: true }, { source_job_id: { not: null } }] } })).toBe(0);
    });

    it('the follow-up job issues exactly the held-back students, with the changed settings', async () => {
        const original = await runJob(admin, jobBody(SEP, [STUDENT.A1, STUDENT.A2], { hold_back_arrears: true, is_revised: true }));
        expect(original.held_back_count).toBe(1);
        expect(original.is_revised).toBe(true);

        const res = await admin.post(`/bulk-voucher-jobs/${original.id}/held-back`).send({
            ...jobBody(SEP, []),
            student_ccs: undefined,
            due_date: '2026-09-20',
            validity_date: '2026-09-25',
            skip_already_issued: false, // forced back on: never regenerates
        });
        expect(res.status).toBe(202);
        expect(res.body.data).toMatchObject({ source_job_id: original.id, student_count: 1 });
        const followUp = await waitForJob(admin, res.body.data.job_id);

        expect(followUp.status).toBe('DONE');
        expect(followUp.source_job_id).toBe(original.id);
        expect(followUp.hold_back_arrears).toBe(false);
        expect(followUp.skip_already_issued).toBe(true);
        expect(followUp.success_count).toBe(1);
        expect(followUp.report.map((r: any) => r.cc)).toEqual([STUDENT.A1]);

        const [a1Sep] = await liveSepVouchers(STUDENT.A1);
        expect(a1Sep.bulk_voucher_job_id).toBe(followUp.id);
        expect(a1Sep.due_date.toISOString().slice(0, 10)).toBe('2026-09-20');
        expect(a1Sep.validity_date?.toISOString().slice(0, 10)).toBe('2026-09-25');
        // The follow-up issues with arrears like any voucher: August rides along.
        expect(Number(a1Sep.total_arrears)).toBe(MTF);
        // A2 was issued by the original job and nobody else.
        expect(await liveSepVouchers(STUDENT.A2)).toHaveLength(1);

        const refreshed = await waitForJob(admin, original.id);
        expect(refreshed.follow_up_jobs.map((j: any) => j.id)).toEqual([followUp.id]);
        const list = await admin.get('/bulk-voucher-jobs');
        expect(list.body.data.find((j: any) => j.id === followUp.id)).toMatchObject({ source_job_id: original.id });
    });

    it('a held-back student issued in between is skipped by the follow-up, not given a second voucher', async () => {
        const original = await runJob(admin, jobBody(SEP, [STUDENT.A1, STUDENT.A2], { hold_back_arrears: true }));
        expect(original.held_back_count).toBe(1);

        // Someone issues A1's September voucher by hand (an ordinary job).
        const between = await runJob(admin, jobBody(SEP, [STUDENT.A1]));
        expect(between.success_count).toBe(1);
        expect(await liveSepVouchers(STUDENT.A1)).toHaveLength(1);

        const res = await admin.post(`/bulk-voucher-jobs/${original.id}/held-back`).send({ ...jobBody(SEP, []), student_ccs: undefined });
        expect(res.status).toBe(202);
        const followUp = await waitForJob(admin, res.body.data.job_id);

        expect(followUp.success_count).toBe(0);
        expect(followUp.skip_count).toBe(1);
        expect(followUp.report).toEqual([
            expect.objectContaining({ cc: STUDENT.A1, status: 'SKIPPED', reason: `Voucher already issued for period starting ${SEP}` }),
        ]);
        expect(await liveSepVouchers(STUDENT.A1)).toHaveLength(1);
    });

    it('refuses a follow-up for students outside the caller\'s scope, and for students the job never held back', async () => {
        // Admin (no scope) runs a campus-A-labelled job that also holds back B1.
        const original = await runJob(
            admin,
            jobBody(SEP, [STUDENT.A1, STUDENT.A2, STUDENT.B1], { hold_back_arrears: true, campus_ids: [CAMPUS_A] }),
        );
        expect(original.held_back_count).toBe(2);

        const body = { ...jobBody(SEP, []), student_ccs: undefined };
        // The campus-A clerk can see the job but not B1.
        const refused = await bulkClerk.post(`/bulk-voucher-jobs/${original.id}/held-back`).send(body);
        expect(refused.status).toBe(403);
        expect(JSON.stringify(refused.body)).toContain(String(STUDENT.B1));
        expect(await prisma.bulk_voucher_jobs.count({ where: { source_job_id: original.id } })).toBe(0);

        // A student the job did not hold back can't be added.
        const notHeld = await bulkClerk.post(`/bulk-voucher-jobs/${original.id}/held-back`).send({ ...body, student_ccs: [STUDENT.A2] });
        expect(notHeld.status).toBe(400);

        // Narrowed to their own campus, it goes through.
        const ok = await bulkClerk.post(`/bulk-voucher-jobs/${original.id}/held-back`).send({ ...body, student_ccs: [STUDENT.A1] });
        expect(ok.status).toBe(202);
        const followUp = await waitForJob(bulkClerk, ok.body.data.job_id);
        expect(followUp.report.map((r: any) => r.cc)).toEqual([STUDENT.A1]);
        expect(await liveSepVouchers(STUDENT.B1)).toHaveLength(0);

        // A job labelled with a campus outside their scope is not theirs to see.
        const campusB = await runJob(admin, jobBody(SEP, [STUDENT.B1], { hold_back_arrears: true, campus_ids: [CAMPUS_B] }));
        const hidden = await bulkClerk.post(`/bulk-voucher-jobs/${campusB.id}/held-back`).send(body);
        expect(hidden.status).toBe(404);
    });
});
