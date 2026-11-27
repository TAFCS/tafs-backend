/**
 * TAFSD-613: clearing the deposit of a split that did not issue its balance voucher.
 *
 * CC 7542, 25 Nov 2026: a Rs 40,000 deposit on voucher #14186 (Sep balance and Oct
 * as arrears, Nov current), a split with "don't generate balance voucher", then the
 * deposit was cleared. Clearing deleted the split's PAID receipt but never undid the
 * split: the full undo only knew a two-child family, and the fallback destroy reset
 * only current-period heads, so Sep and Oct stayed PAID with no money behind them.
 *
 * End to end over HTTP against the throwaway database: issue through POST /vouchers,
 * pay through /deposit, split through /split-partially-paid with DO_NOT_ISSUE, clear
 * through /clear-deposit. PDF rendering and storage are stubbed; the split renders
 * its receipt after its transaction, which is not what this file tests.
 *
 * What has to hold:
 *  - the clean case undoes the split: the original voucher is live again with its
 *    heads, every fee unpaid, the receipt and the deposit gone;
 *  - when the unbilled side has changed since the split (here, a head added later),
 *    the undo does not guess: the original stays VOID, but every fee the deposit
 *    paid is unpaid again;
 *  - in both, no fee is left with amount_paid that no allocation backs.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { VoucherPdfService } from '../../src/modules/voucher-pdf/voucher-pdf.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, CLASS_AUG, FEE, SECTION, STUDENT, USERS, YEAR, seedSchool } from './helpers/fixtures';

const MTF = 10000;
const SEP = '2026-09-01';
const OCT = '2026-10-01';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let admin: ReturnType<typeof client>;

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    admin = client(app, tokenFor(jwt, USERS.admin));
    jest.spyOn(app.get(VoucherPdfService), 'generateVoucherPdf').mockResolvedValue(Buffer.from('%PDF-stub') as any);
    jest.spyOn(app.get(StorageService), 'upload').mockImplementation(async (key: string) => `https://stub.local/${key}`);
});

afterAll(async () => {
    await app?.close();
});

const fee = (month: number, feeDate: string, feeType: number = FEE.MTF, amount = MTF) =>
    prisma.student_fees.create({
        data: {
            student_id: STUDENT.A1,
            fee_type_id: feeType,
            academic_year: YEAR,
            target_month: month,
            month,
            fee_date: new Date(feeDate),
            amount_before_discount: new Prisma.Decimal(amount),
            amount: new Prisma.Decimal(amount),
            term_start_month: 8,
        },
    });

let sepId: number;
let octId: number;
let voucherId: number;
let receiptId: number;
let depositId: number;

/**
 * Sep (an arrear) and Oct on one voucher dated Oct, Rs 1,000 Sep surcharge:
 * Rs 21,000. Rs 15,000 pays Sep and half of Oct; split without a balance voucher.
 */
beforeEach(async () => {
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "audit_logs", "deposit_allocations", "deposits", "voucher_arrear_surcharges", "voucher_heads", ' +
        '"vouchers", "student_fees" RESTART IDENTITY CASCADE',
    );
    sepId = (await fee(9, SEP)).id;
    octId = (await fee(10, OCT)).id;

    const issued = await admin.post('/vouchers').send({
        student_id: STUDENT.A1,
        campus_id: CAMPUS_A,
        class_id: CLASS_AUG,
        section_id: SECTION,
        bank_account_id: 1,
        issue_date: '2026-10-01',
        due_date: '2026-10-10',
        validity_date: '2026-10-15',
        fee_date: OCT,
        academic_year: YEAR,
        month: 10,
        late_fee_charge: false,
        send_notification: false,
        orderedFeeIds: [octId],
    });
    expect(issued.status).toBe(201);
    voucherId = issued.body.data.id;
    const v = await prisma.vouchers.findUniqueOrThrow({ where: { id: voucherId }, include: { voucher_heads: true } });
    expect(Number(v.total_payable_before_due)).toBe(2 * MTF + 1000);

    const headFor = (sf: number) => v.voucher_heads.find((h) => h.student_fee_id === sf)!.id;
    const paid = await admin.post(`/vouchers/${voucherId}/deposit`).send({
        amount: 15000,
        distributions: { [headFor(sepId)]: MTF, [headFor(octId)]: 5000 },
        payment_method: 'cash',
    });
    expect(paid.status).toBe(200);
    depositId = (await prisma.deposits.findFirstOrThrow()).id;

    const split = await admin.post(`/vouchers/${voucherId}/split-partially-paid`).send({
        issue_date: '2026-10-12',
        due_date: '2026-10-20',
        balance_disposition: 'DO_NOT_ISSUE',
        send_notification: false,
    });
    expect(split.status).toBe(201);
    const children = await prisma.vouchers.findMany({ where: { split_parent_id: voucherId } });
    expect(children.map((c) => c.status)).toEqual(['PAID']);
    receiptId = children[0].id;
});

/** Fees whose amount_paid no deposit allocation backs. */
async function paidWithoutMoney() {
    return prisma.$queryRaw<{ id: number }[]>`
        SELECT sf.id FROM student_fees sf
         WHERE NOT sf.is_discount
           AND sf.amount_paid > COALESCE((SELECT SUM(a.amount) FROM deposit_allocations a WHERE a.student_fee_id = sf.id), 0)`;
}

describe('clearing the deposit of a split with no balance voucher', () => {
    it('undoes the split: the original voucher is live again with every fee unpaid', async () => {
        const res = await admin.post(`/vouchers/${receiptId}/clear-deposit`).send({ depositId });
        expect(res.status).toBe(200);

        expect(await prisma.vouchers.findUnique({ where: { id: receiptId } })).toBeNull();
        expect(await prisma.deposits.count()).toBe(0);

        const parent = await prisma.vouchers.findUniqueOrThrow({
            where: { id: voucherId },
            include: { voucher_heads: { orderBy: { student_fee_id: 'asc' } }, voucher_arrear_surcharges: true },
        });
        expect(['UNPAID', 'OVERDUE']).toContain(parent.status);
        expect(parent.voucher_heads.map((h) => [h.student_fee_id, Number(h.net_amount), Number(h.balance)])).toEqual([
            [sepId, MTF, MTF],
            [octId, MTF, MTF],
        ]);
        expect(parent.voucher_arrear_surcharges.every((s) => Number(s.amount_paid) === 0)).toBe(true);

        const fees = await prisma.student_fees.findMany({ where: { student_id: STUDENT.A1 }, orderBy: { id: 'asc' } });
        expect(fees.map((f) => [f.id, f.status, Number(f.amount), Number(f.amount_paid), f.description_prefix])).toEqual([
            [sepId, 'ISSUED', MTF, 0, null],
            [octId, 'ISSUED', MTF, 0, null],
        ]);
        expect(await paidWithoutMoney()).toEqual([]);
    });

    it('does not guess when the unbilled side changed since the split, but leaves no fee paid without money', async () => {
        // A head added after the split (as a bulk add would), dated before the voucher.
        await fee(9, SEP, FEE.CAUTION, 5000);

        const res = await admin.post(`/vouchers/${receiptId}/clear-deposit`).send({ depositId });
        expect(res.status).toBe(200);

        expect(await prisma.vouchers.findUnique({ where: { id: receiptId } })).toBeNull();
        expect(await prisma.deposits.count()).toBe(0);
        expect((await prisma.vouchers.findUniqueOrThrow({ where: { id: voucherId } })).status).toBe('VOID');

        // Sep was an arrear head on the receipt: the old fallback left it PAID.
        const sep = await prisma.student_fees.findUniqueOrThrow({ where: { id: sepId } });
        expect(sep.status).toBe('NOT_ISSUED');
        expect(Number(sep.amount_paid)).toBe(0);
        const oct = await prisma.student_fees.findUniqueOrThrow({ where: { id: octId } });
        expect(Number(oct.amount)).toBe(MTF);
        expect(Number(oct.amount_paid)).toBe(0);
        expect(await paidWithoutMoney()).toEqual([]);
    });
});
