/**
 * TAFSD-617: the Vouchers page list.
 *
 *  - is_latest_for_student is the student's latest voucher of ALL their
 *    vouchers, the one remove() and regenerate() accept, not the newest of the
 *    rows the filters let through. A status filter that hides the newer voucher
 *    must not make an older one look deletable.
 *  - the count cards have one bucket per status (waived and partially paid
 *    included) and add up to the total.
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

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    admin = client(app, tokenFor(jwt, USERS.admin));
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

const list = async (query: Record<string, string | number>) => {
    const res = await admin.get('/vouchers').query({ cc: STUDENT.A1, ...query });
    expect(res.status).toBe(200);
    return res.body.data as {
        items: Array<{ id: number; status: string; is_latest_for_student: boolean }>;
        meta: Record<string, number>;
    };
};

describe('GET /vouchers', () => {
    it('marks only the student\'s latest voucher as latest, whatever the filters', async () => {
        const aug = await issue(AUG, 8);
        const sep = await issue(SEP, 9);

        const all = await list({});
        expect(all.items.find((v) => v.id === sep)?.is_latest_for_student).toBe(true);
        expect(all.items.find((v) => v.id === aug)?.is_latest_for_student).toBe(false);

        // Filter the newer voucher out: the older one is still not the latest.
        const augStatus = all.items.find((v) => v.id === aug)!.status;
        const filtered = await list({ status: augStatus });
        expect(filtered.items.map((v) => v.id)).toEqual([aug]);
        expect(filtered.items[0].is_latest_for_student).toBe(false);

        // The server agrees: deleting the older voucher is refused.
        const del = await admin.delete(`/vouchers/${aug}`);
        expect(del.status).toBe(400);
    });

    it('counts waived and partially paid vouchers in their own cards, adding up to the total', async () => {
        const aug = await issue(AUG, 8);
        const sep = await issue(SEP, 9);
        await prisma.vouchers.update({ where: { id: aug }, data: { status: 'WAIVED' } });
        await prisma.vouchers.update({ where: { id: sep }, data: { status: 'PARTIALLY_PAID' } });

        const { meta } = await list({});
        expect(meta).toMatchObject({
            total: 2,
            paid: 0,
            unpaid: 0,
            partially_paid: 1,
            overdue: 0,
            expired: 0,
            waived: 1,
            void: 0,
        });

        const waivedOnly = await list({ status: 'WAIVED' });
        expect(waivedOnly.items.map((v) => v.id)).toEqual([aug]);
        expect(waivedOnly.meta).toMatchObject({ total: 1, waived: 1, unpaid: 0 });
    });
});
