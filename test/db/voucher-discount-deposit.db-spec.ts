/**
 * TAFSD-581: an expired voucher carrying a discount is collected net of it.
 *
 * Voucher 14176 (CC 7165) printed Rs 233,943 after due: a year of tuition, a
 * Rs 39,656 "full year advance payment" discount and the Rs 1,000 late fee. It
 * had expired by the time the family paid. For an EXPIRED voucher the API sent
 * no net total, so the deposit page summed the heads, skipped the discount,
 * and asked for Rs 273,599, which is what was recorded. The discount was never
 * used. Eleven other "full year advance" vouchers were booked the same way.
 *
 * End to end over HTTP against the throwaway database: the voucher is issued
 * through POST /vouchers, expired the way the validity-date cron does it, read
 * through GET /vouchers/:id, and paid through POST /vouchers/:id/deposit.
 *
 * What has to hold:
 *  - GET returns the challan's figure, discount netted, and keeps EXPIRED;
 *  - a deposit paying every head at its full amount is refused, and writes nothing;
 *  - the discounted amount is accepted, spends the discount and settles the voucher.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, CLASS_AUG, FEE, SECTION, STUDENT, USERS, YEAR, seedSchool } from './helpers/fixtures';

const FEE_DATE = '2026-11-01';
const MTF = 10000;
const DISCOUNT = 4000;

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let admin: ReturnType<typeof client>;

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    admin = client(app, tokenFor(jwt, USERS.admin));
});

afterAll(async () => {
    await app?.close();
});

let voucherId: number;
let discountFeeId: number;

beforeEach(async () => {
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "audit_logs", "deposit_allocations", "deposits", "voucher_arrear_surcharges", "voucher_heads", ' +
        '"vouchers", "student_fees", "discount_presets" RESTART IDENTITY CASCADE',
    );
    // Two months billed together on one fee date, with an advance-payment discount.
    for (const month of [9, 10]) {
        await prisma.student_fees.create({
            data: {
                student_id: STUDENT.A1,
                fee_type_id: FEE.MTF,
                academic_year: YEAR,
                target_month: month,
                month,
                fee_date: new Date(FEE_DATE),
                amount_before_discount: new Prisma.Decimal(MTF),
                amount: new Prisma.Decimal(MTF),
                term_start_month: 8,
            },
        });
    }
    const preset = await prisma.discount_presets.create({ data: { title: 'FULL YEAR ADVANCE PAYMENT DISCOUNT' } });
    const discount = await prisma.student_fees.create({
        data: {
            student_id: STUDENT.A1,
            academic_year: YEAR,
            target_month: 9,
            fee_date: new Date(FEE_DATE),
            amount: new Prisma.Decimal(DISCOUNT),
            amount_after_discount: new Prisma.Decimal(DISCOUNT),
            is_discount: true,
            status: 'DISCOUNT',
            discount_type_id: preset.id,
            term_start_month: 8,
        },
    });
    discountFeeId = discount.id;

    const fees = await prisma.student_fees.findMany({ where: { student_id: STUDENT.A1 }, orderBy: { id: 'asc' } });
    const res = await admin.post('/vouchers').send({
        student_id: STUDENT.A1,
        campus_id: CAMPUS_A,
        class_id: CLASS_AUG,
        section_id: SECTION,
        bank_account_id: 1,
        issue_date: '2026-10-23',
        due_date: '2026-11-09',
        validity_date: '2026-11-13',
        fee_date: FEE_DATE,
        academic_year: YEAR,
        month: 9,
        late_fee_charge: false,
        send_notification: false,
        orderedFeeIds: fees.map((f) => f.id),
    });
    expect(res.status).toBe(201);
    voucherId = res.body.data.id;
    // What the validity-date cron does once 13 Nov has passed.
    await prisma.vouchers.update({ where: { id: voucherId }, data: { status: 'EXPIRED' } });
});

const tuitionHeads = () =>
    prisma.voucher_heads.findMany({
        where: { voucher_id: voucherId, student_fees: { is_discount: false } },
        orderBy: { id: 'asc' },
    });

describe('an EXPIRED voucher with a discount', () => {
    it('is read at the challan amount, discount netted, and stays EXPIRED', async () => {
        const v = await prisma.vouchers.findUniqueOrThrow({ where: { id: voucherId } });
        expect(Number(v.total_payable_before_due)).toBe(2 * MTF - DISCOUNT);

        const res = await admin.get(`/vouchers/${voucherId}`);
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('EXPIRED');
        expect(res.body.data.total_balance).toBe(String((2 * MTF - DISCOUNT).toFixed(2)));
        expect(res.body.data.total_discount_unapplied).toBe(String(DISCOUNT.toFixed(2)));
    });

    it('refuses a deposit that pays every head in full and leaves the discount unused', async () => {
        const [a, b] = await tuitionHeads();
        const res = await admin.post(`/vouchers/${voucherId}/deposit`).send({
            amount: 2 * MTF,
            distributions: { [a.id]: MTF, [b.id]: MTF },
            payment_method: 'online',
        });

        expect(res.status).toBe(400);
        expect(res.body.message).toContain('discount');
        // Rolled back: no deposit, nothing paid, voucher unchanged.
        expect(await prisma.deposits.count()).toBe(0);
        expect(await prisma.deposit_allocations.count()).toBe(0);
        const fees = await prisma.student_fees.findMany({ where: { student_id: STUDENT.A1 } });
        expect(fees.every((f) => Number(f.amount_paid) === 0)).toBe(true);
        expect((await prisma.vouchers.findUniqueOrThrow({ where: { id: voucherId } })).status).toBe('EXPIRED');
    });

    it('accepts the discounted amount, spends the discount and settles the voucher', async () => {
        const [a, b] = await tuitionHeads();
        const res = await admin.post(`/vouchers/${voucherId}/deposit`).send({
            amount: 2 * MTF - DISCOUNT,
            distributions: { [a.id]: MTF, [b.id]: MTF - DISCOUNT },
            payment_method: 'online',
        });

        expect(res.status).toBe(200);
        const v = await prisma.vouchers.findUniqueOrThrow({ where: { id: voucherId } });
        expect(v.status).toBe('PAID');
        const discount = await prisma.student_fees.findUniqueOrThrow({ where: { id: discountFeeId } });
        expect(Number(discount.amount_paid)).toBe(DISCOUNT);
        const deposit = await prisma.deposits.findFirstOrThrow();
        expect(Number(deposit.total_amount)).toBe(2 * MTF - DISCOUNT);
    });
});
