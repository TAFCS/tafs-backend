/**
 * TAFSD-533: the studentwise-fees bulk and bundle routes validate their bodies.
 *
 * They used to take `@Body() dto: any`, which the global ValidationPipe skips,
 * so a negative amount or junk fields were written straight to student_fees and
 * a wrong type surfaced as a 500. Each route gets: bad bodies -> 400 with
 * nothing written, and the exact payload the webapp sends -> still accepted.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { FEE, STUDENT, USERS, YEAR, seedSchool } from './helpers/fixtures';

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

const feeCount = () => prisma.student_fees.count();

async function expectRejected(send: () => Promise<{ status: number }>, label: string) {
    const before = await feeCount();
    const res = await send();
    expect({ label, status: res.status }).toEqual({ label, status: 400 });
    expect(await feeCount()).toBe(before);
}

/** Heads A1 can bundle: tuition and annual charges for August. */
async function twoHeads() {
    const [mtf, annual] = await Promise.all([
        prisma.student_fees.create({ data: { student_id: STUDENT.A1, fee_type_id: FEE.MTF, academic_year: YEAR, target_month: 8, month: 8, amount: 18995, fee_date: new Date('2026-08-01') } }),
        prisma.student_fees.create({ data: { student_id: STUDENT.A1, fee_type_id: FEE.ANNUAL, academic_year: YEAR, target_month: 8, month: 8, amount: 5000, fee_date: new Date('2026-08-01') } }),
    ]);
    return [mtf, annual];
}

describe('POST /student-fees/bulk-add', () => {
    // TabAddSingle.tsx handleConfirm
    const body = (over: object = {}) => ({
        academic_year: YEAR, fee_type_id: FEE.ANNUAL, month: 8, fee_date: '2026-08-01', amount: 5000, student_ids: [STUDENT.A1], ...over,
    });

    it('rejects a negative amount, a non-numeric amount, junk fields and missing fields', async () => {
        await expectRejected(() => admin.post('/student-fees/bulk-add').send(body({ amount: -750 })), 'negative amount');
        await expectRejected(() => admin.post('/student-fees/bulk-add').send(body({ amount: 'abc' })), 'non-numeric amount');
        await expectRejected(() => admin.post('/student-fees/bulk-add').send(body({ junk: 1 })), 'unknown field');
        await expectRejected(() => admin.post('/student-fees/bulk-add').send(body({ fee_date: undefined })), 'missing fee_date');
        await expectRejected(() => admin.post('/student-fees/bulk-add').send(body({ month: 13 })), 'month out of range');
        await expectRejected(() => admin.post('/student-fees/bulk-add').send(body({ student_ids: ['A1'] })), 'non-integer student id');
    });

    it('accepts the webapp\'s payload, including a zero amount', async () => {
        expect((await admin.post('/student-fees/bulk-add').send(body())).status).toBe(200);
        expect((await admin.post('/student-fees/bulk-add').send(body({ amount: 0, student_ids: [STUDENT.A2] }))).status).toBe(200);
        expect(await feeCount()).toBe(2);
    });
});

describe('POST /student-fees/bulk-add-range', () => {
    // TabAddRange.tsx handleConfirmWithStudents
    const body = (over: object = {}) => ({
        academic_year: YEAR, fee_type_id: FEE.MTF, start_month: 8, end_month: 9, day: 1, amount: 18995, student_ids: [STUDENT.A1], ...over,
    });

    it('rejects a non-numeric or negative amount, a bad month or day, and junk fields', async () => {
        await expectRejected(() => admin.post('/student-fees/bulk-add-range').send(body({ amount: 'abc' })), 'non-numeric amount');
        await expectRejected(() => admin.post('/student-fees/bulk-add-range').send(body({ amount: -1 })), 'negative amount');
        await expectRejected(() => admin.post('/student-fees/bulk-add-range').send(body({ end_month: 13 })), 'month out of range');
        await expectRejected(() => admin.post('/student-fees/bulk-add-range').send(body({ day: 32 })), 'day out of range');
        await expectRejected(() => admin.post('/student-fees/bulk-add-range').send(body({ junk: true })), 'unknown field');
    });

    it('accepts the webapp\'s payload', async () => {
        const res = await admin.post('/student-fees/bulk-add-range').send(body());
        expect(res.status).toBe(200);
        expect(await feeCount()).toBe(2);
    });
});

describe('DELETE /student-fees/bulk-delete', () => {
    it('rejects non-integer ids and junk fields, deleting nothing', async () => {
        await twoHeads();
        await expectRejected(() => admin.delete('/student-fees/bulk-delete').send({ student_fee_ids: ['1'] }), 'string id');
        await expectRejected(() => admin.delete('/student-fees/bulk-delete').send({ student_fee_ids: [1], everything: true }), 'unknown field');
        await expectRejected(() => admin.delete('/student-fees/bulk-delete').send({}), 'missing ids');
    });

    it('accepts the webapp\'s payload', async () => {
        const [mtf] = await twoHeads();
        // TabDeleteSingle.tsx / TabDeleteRange.tsx
        const res = await admin.delete('/student-fees/bulk-delete').send({ student_fee_ids: [mtf.id] });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ deleted: 1, blocked: 0 });
    });
});

describe('bundles', () => {
    it('POST rejects a missing name, non-integer fee ids and junk fields', async () => {
        const [mtf, annual] = await twoHeads();
        const base = { student_id: STUDENT.A1, bundle_name: 'AUGUST', academic_year: YEAR, fee_ids: [mtf.id, annual.id] };
        for (const [label, bad] of [
            ['missing name', { ...base, bundle_name: undefined }],
            ['string fee id', { ...base, fee_ids: [String(mtf.id), annual.id] }],
            ['unknown field', { ...base, colour: 'red' }],
            ['bad date override', { ...base, fee_date_overrides: [{ id: 'x', fee_date: '2026-08-02' }] }],
        ] as const) {
            const res = await admin.post('/student-fees/bundles').send(bad);
            expect({ label, status: res.status }).toEqual({ label, status: 400 });
        }
        expect(await prisma.student_fee_bundles.count()).toBe(0);
    });

    it('POST accepts the webapp\'s payload', async () => {
        const [mtf, annual] = await twoHeads();
        // page.tsx handleCreateBundle
        const res = await admin.post('/student-fees/bundles').send({
            student_id: STUDENT.A1, bundle_name: 'AUGUST', target_month: 8, academic_year: YEAR,
            fee_ids: [mtf.id, annual.id],
            fee_date_overrides: [{ id: mtf.id, fee_date: '2026-08-01' }, { id: annual.id, fee_date: '2026-08-01' }],
        });
        expect(res.status).toBe(201);
    });

    it('PATCH validates its body too', async () => {
        const [mtf, annual] = await twoHeads();
        const id = (await admin.post('/student-fees/bundles').send({
            student_id: STUDENT.A1, bundle_name: 'AUGUST', academic_year: YEAR, fee_ids: [mtf.id, annual.id],
        })).body.data.id;

        for (const [label, bad] of [
            ['unknown field', { bundle_name: 'X', colour: 'red' }],
            ['name not a string', { bundle_name: 42 }],
            ['string fee id', { fee_ids: ['1'] }],
        ] as const) {
            const res = await admin.patch(`/student-fees/bundles/${id}`).send(bad);
            expect({ label, status: res.status }).toEqual({ label, status: 400 });
        }
        expect((await prisma.student_fee_bundles.findUniqueOrThrow({ where: { id } })).bundle_name).toBe('AUGUST');

        expect((await admin.patch(`/student-fees/bundles/${id}`).send({ bundle_name: 'AUG' })).status).toBe(200);
        expect((await prisma.student_fee_bundles.findUniqueOrThrow({ where: { id } })).bundle_name).toBe('AUG');
    });
});
