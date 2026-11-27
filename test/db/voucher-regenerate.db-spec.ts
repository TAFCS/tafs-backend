/**
 * TAFSD-550 (Rule B): Regenerate on a student's latest voucher reissues it with
 * the /fee-challan settings. End to end over HTTP against the throwaway
 * database: vouchers are issued through POST /vouchers (the real create()) and
 * regenerated through POST /vouchers/:id/regenerate.
 *
 * What has to hold:
 *  - every setting the form sends lands on the new voucher;
 *  - the new voucher bills the same heads for the same fee date;
 *  - the old voucher is VOID and linked to the new one, and deleting the new one
 *    brings it back (Rule A), with its own predecessors still linked to it;
 *  - only the latest voucher can be regenerated, and only with the Regenerate grant.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, CLASS_AUG, FEE, SECTION, STUDENT, USERS, YEAR, seedSchool } from './helpers/fixtures';

const MTF = 18995;
const AUG = '2026-08-01';
const SEP = '2026-09-01';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let admin: ReturnType<typeof client>;
let viewer: ReturnType<typeof client>;

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    await prisma.bank_accounts.create({
        data: { id: 2, account_title: 'TEST SCHOOL TWO', account_number: '0000-TWO', bank_name: 'Other Bank' },
    });
    admin = client(app, tokenFor(jwt, USERS.admin));
    viewer = client(app, tokenFor(jwt, USERS.viewer));
});

afterAll(async () => {
    await app?.close();
});

beforeEach(async () => {
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "audit_logs", "deposit_allocations", "deposits", "voucher_arrear_surcharges", "voucher_heads", ' +
        '"vouchers", "student_fees" RESTART IDENTITY CASCADE',
    );
    for (const [feeDate, month] of [[AUG, 8], [SEP, 9]] as const) {
        await prisma.student_fees.create({
            data: {
                student_id: STUDENT.A1,
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
});

/** Issue one voucher for A1's heads on `feeDate`, as /fee-challan does. */
async function issue(feeDate: string, month: number) {
    const fees = await prisma.student_fees.findMany({ where: { student_id: STUDENT.A1, fee_date: new Date(feeDate) } });
    const res = await admin.post('/vouchers').send({
        student_id: STUDENT.A1,
        campus_id: CAMPUS_A,
        class_id: CLASS_AUG,
        section_id: SECTION,
        bank_account_id: 1,
        issue_date: feeDate,
        due_date: feeDate.slice(0, 8) + '10',
        validity_date: feeDate.slice(0, 8) + '20',
        fee_date: feeDate,
        academic_year: YEAR,
        month,
        late_fee_charge: false,
        send_notification: false,
        orderedFeeIds: fees.map((f) => f.id),
    });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
}

const SETTINGS = {
    issue_date: '2026-09-05',
    due_date: '2026-09-25',
    validity_date: '2026-09-30',
    bank_account_id: 2,
    late_fee_charge: true,
    late_fee_amount: 1500,
    reprint_fee_charge: true,
    reprint_fee_amount: 200,
    waive_surcharge: false,
    send_notification: false,
    requires_release: true,
    is_revised: true,
};

const voucher = (id: number) =>
    prisma.vouchers.findUniqueOrThrow({
        where: { id },
        include: { voucher_heads: { orderBy: { student_fee_id: 'asc' } }, voucher_arrear_surcharges: true },
    });

describe('POST /vouchers/:id/regenerate', () => {
    it('reissues the latest voucher with every setting, voids it, and the delete brings it back', async () => {
        const v1 = await issue(SEP, 9);
        const before = await voucher(v1);

        const res = await admin.post(`/vouchers/${v1}/regenerate`).send(SETTINGS);
        expect(res.status).toBe(200);
        const v2 = res.body.data.voucher.id as number;
        expect(v2).not.toBe(v1);
        expect(res.body.data.replaced_voucher_id).toBe(v1);

        const after = await voucher(v2);
        expect(after).toMatchObject({
            student_id: STUDENT.A1,
            fee_date: new Date(SEP),
            month: 9,
            bank_account_id: 2,
            issue_date: new Date('2026-09-05'),
            due_date: new Date('2026-09-25'),
            validity_date: new Date('2026-09-30'),
            late_fee_charge: true,
            reprint_fee_charge: true,
            is_revised: true,
            released_to_parent_at: null,
            status: 'UNPAID',
        });
        expect(String(after.reprint_fee_amount)).toBe('200');
        // Same heads, plus the August arrear issued with them, nothing else.
        expect(after.voucher_heads.map((h) => h.student_fee_id)).toEqual(before.voucher_heads.map((h) => h.student_fee_id));
        // Two months of tuition + one Rs 1,000 August surcharge + reprint fee; late fee on top after due.
        const beforeDue = 2 * MTF + 1000 + 200;
        expect(Number(after.total_payable_before_due)).toBe(beforeDue);
        expect(Number(after.total_payable_after_due)).toBe(beforeDue + 1500);

        const old = await prisma.vouchers.findUniqueOrThrow({ where: { id: v1 } });
        expect(old.status).toBe('VOID');
        expect(old.superseded_by_voucher_id).toBe(v2);

        // Rule A: delete the regenerated voucher -> the old one is live again.
        const del = await admin.delete(`/vouchers/${v2}`);
        expect(del.status).toBe(200);
        const restored = await prisma.vouchers.findUniqueOrThrow({ where: { id: v1 } });
        // Valid to 20 Sep 2026, long past: it comes back EXPIRED, as the scheduler
        // would make it, not OVERDUE (TAFSD-622).
        expect(restored.status).toBe('EXPIRED');
        expect(restored.superseded_by_voucher_id).toBeNull();
    });

    it('re-derives the surcharge, keeps the chain, and only the latest voucher can be regenerated', async () => {
        const aug = await issue(AUG, 8);
        const sep = await issue(SEP, 9); // supersedes August
        expect((await prisma.vouchers.findUniqueOrThrow({ where: { id: aug } })).superseded_by_voucher_id).toBe(sep);

        const notLatest = await admin.post(`/vouchers/${aug}/regenerate`).send(SETTINGS);
        expect(notLatest.status).toBe(400);

        const res = await admin.post(`/vouchers/${sep}/regenerate`).send({ ...SETTINGS, waive_surcharge: true, reprint_fee_charge: false });
        expect(res.status).toBe(200);
        const regen = await voucher(res.body.data.voucher.id);
        expect(regen.surcharge_waived).toBe(true);
        expect(regen.voucher_arrear_surcharges.every((s) => s.waived)).toBe(true);
        expect(Number(regen.total_payable_before_due)).toBe(2 * MTF);

        // August still points at September, September at the regenerated one.
        expect((await prisma.vouchers.findUniqueOrThrow({ where: { id: aug } })).superseded_by_voucher_id).toBe(sep);
        expect((await prisma.vouchers.findUniqueOrThrow({ where: { id: sep } })).superseded_by_voucher_id).toBe(regen.id);

        expect((await admin.delete(`/vouchers/${regen.id}`)).status).toBe(200);
        expect((await prisma.vouchers.findUniqueOrThrow({ where: { id: sep } })).status).not.toBe('VOID');
        const augAfter = await prisma.vouchers.findUniqueOrThrow({ where: { id: aug } });
        expect(augAfter.status).toBe('VOID');
        expect(augAfter.superseded_by_voucher_id).toBe(sep);
    });

    it('refuses an issue date earlier than the voucher being regenerated', async () => {
        const v1 = await issue(SEP, 9);
        const res = await admin.post(`/vouchers/${v1}/regenerate`).send({ ...SETTINGS, issue_date: '2026-08-31' });
        expect(res.status).toBe(400);
        expect((await prisma.vouchers.findUniqueOrThrow({ where: { id: v1 } })).status).toBe('UNPAID');
    });

    it('needs the Regenerate grant', async () => {
        const v1 = await issue(SEP, 9);
        const res = await viewer.post(`/vouchers/${v1}/regenerate`).send(SETTINGS);
        expect(res.status).toBe(403);
        expect(await prisma.vouchers.count()).toBe(1);
    });

    it('validates the settings like single issuance does', async () => {
        const v1 = await issue(SEP, 9);
        const res = await admin.post(`/vouchers/${v1}/regenerate`).send({ ...SETTINGS, due_date: 'not-a-date' });
        expect(res.status).toBe(400);
    });
});
