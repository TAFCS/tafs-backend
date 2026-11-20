/**
 * TAFSD-545: a bulk add never gives a student a second copy of a fee head.
 *
 * "Already has it" means the same thing the bulk-add previews show: the
 * student has a head of that fee type on that fee date in that academic year,
 * in any status. Nothing in the schema enforces it (student_fees has no unique
 * constraint), so the write itself must check, and must not race a concurrent
 * bulk add.
 *
 * The range tab of the webapp sends every student in scope, not only those the
 * preview marks "will add", so an overlapping range is the everyday case here,
 * not just a double click.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { FEE, STUDENT, USERS, YEAR, issueVoucher, seedSchool } from './helpers/fixtures';

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
        'TRUNCATE TABLE "audit_logs", "voucher_heads", "vouchers", "student_fees", "student_fee_bundles" RESTART IDENTITY CASCADE',
    );
});

const addOne = (studentIds: number[], over: object = {}) =>
    admin.post('/student-fees/bulk-add').send({
        academic_year: YEAR, fee_type_id: FEE.ANNUAL, month: 8, fee_date: '2026-08-01', amount: 5000, student_ids: studentIds, ...over,
    });

const addRange = (studentIds: number[], over: object = {}) =>
    admin.post('/student-fees/bulk-add-range').send({
        academic_year: YEAR, fee_type_id: FEE.MTF, start_month: 8, end_month: 10, day: 1, amount: 18995, student_ids: studentIds, ...over,
    });

const datesOf = async (studentId: number, feeTypeId: number) =>
    (await prisma.student_fees.findMany({
        where: { student_id: studentId, fee_type_id: feeTypeId },
        orderBy: [{ fee_date: 'asc' }, { id: 'asc' }],
    })).map((r) => r.fee_date?.toISOString().slice(0, 10));

describe('bulk add (one fee date)', () => {
    it('adds nothing the second time and reports who was skipped', async () => {
        const first = await addOne([STUDENT.A1, STUDENT.A2]);
        expect(first.status).toBe(200);
        expect(first.body.data).toMatchObject({ added: 2, skipped: 0 });

        const again = await addOne([STUDENT.A1, STUDENT.A2]);
        expect(again.status).toBe(200);
        expect(again.body.data.added).toBe(0);
        expect(again.body.data.skipped).toBe(2);
        expect(again.body.data.skipped_reasons).toEqual([
            { student_id: STUDENT.A1, reason: 'already_exists' },
            { student_id: STUDENT.A2, reason: 'already_exists' },
        ]);
        expect(await datesOf(STUDENT.A1, FEE.ANNUAL)).toEqual(['2026-08-01']);
        expect(await datesOf(STUDENT.A2, FEE.ANNUAL)).toEqual(['2026-08-01']);
    });

    it('adds only for the students who do not have the head yet', async () => {
        await addOne([STUDENT.A1]);
        const res = await addOne([STUDENT.A1, STUDENT.A2]);
        expect(res.body.data).toMatchObject({ added: 1, skipped: 1 });
        expect(await datesOf(STUDENT.A1, FEE.ANNUAL)).toEqual(['2026-08-01']);
        expect(await datesOf(STUDENT.A2, FEE.ANNUAL)).toEqual(['2026-08-01']);
    });

    it('counts a head that is already on a voucher as existing', async () => {
        await addOne([STUDENT.A1]);
        const [head] = await prisma.student_fees.findMany({ where: { student_id: STUDENT.A1 } });
        await issueVoucher(prisma, STUDENT.A1, [head.id]);

        const res = await addOne([STUDENT.A1]);
        expect(res.body.data).toMatchObject({ added: 0, skipped: 1 });
        expect(await datesOf(STUDENT.A1, FEE.ANNUAL)).toEqual(['2026-08-01']);
    });

    it('a student listed twice in one request gets one head', async () => {
        const res = await addOne([STUDENT.A1, STUDENT.A1]);
        expect(res.body.data).toMatchObject({ added: 1, skipped: 1 });
        expect(await datesOf(STUDENT.A1, FEE.ANNUAL)).toEqual(['2026-08-01']);
    });

    it('still adds the same fee type on a different date', async () => {
        await addOne([STUDENT.A1]);
        const res = await addOne([STUDENT.A1], { fee_date: '2026-09-01', month: 9 });
        expect(res.body.data).toMatchObject({ added: 1, skipped: 0 });
        expect(await datesOf(STUDENT.A1, FEE.ANNUAL)).toEqual(['2026-08-01', '2026-09-01']);
    });

    it('two identical requests at once still give one head per student', async () => {
        const [a, b] = await Promise.all([addOne([STUDENT.A1, STUDENT.A2]), addOne([STUDENT.A1, STUDENT.A2])]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(a.body.data.added + b.body.data.added).toBe(2);
        expect(await datesOf(STUDENT.A1, FEE.ANNUAL)).toEqual(['2026-08-01']);
        expect(await datesOf(STUDENT.A2, FEE.ANNUAL)).toEqual(['2026-08-01']);
    });
});

describe('bulk add range (several months)', () => {
    it('skips the months a student already has, as the conflicts preview promised', async () => {
        // A1 already has September's tuition, e.g. from the fee grid.
        await prisma.student_fees.create({
            data: { student_id: STUDENT.A1, fee_type_id: FEE.MTF, academic_year: YEAR, target_month: 9, month: 9, amount: 18995, fee_date: new Date('2026-09-01') },
        });

        const res = await addRange([STUDENT.A1, STUDENT.A2]);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ total_added: 5, total_skipped: 1 });
        expect(res.body.data.summary).toEqual([
            { month: 8, added: 2, skipped: 0 },
            { month: 9, added: 1, skipped: 1 },
            { month: 10, added: 2, skipped: 0 },
        ]);
        expect(await datesOf(STUDENT.A1, FEE.MTF)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
        expect(await datesOf(STUDENT.A2, FEE.MTF)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
    });

    it('adds nothing when the same range is run again', async () => {
        await addRange([STUDENT.A1, STUDENT.A2]);
        const again = await addRange([STUDENT.A1, STUDENT.A2]);
        expect(again.body.data).toMatchObject({ total_added: 0, total_skipped: 6 });
        expect(await datesOf(STUDENT.A1, FEE.MTF)).toHaveLength(3);
        expect(await datesOf(STUDENT.A2, FEE.MTF)).toHaveLength(3);
    });

    it('an overlapping range adds only the new months', async () => {
        await addRange([STUDENT.A1], { start_month: 8, end_month: 9 });
        const res = await addRange([STUDENT.A1], { start_month: 9, end_month: 10 });
        expect(res.body.data).toMatchObject({ total_added: 1, total_skipped: 1 });
        expect(await datesOf(STUDENT.A1, FEE.MTF)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
    });
});
