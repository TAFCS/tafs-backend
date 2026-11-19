/**
 * Studentwise fees (webapp /studentwise-fees, tile finance.student_overrides),
 * end to end: real HTTP requests through the real guards into a real Postgres.
 *
 * Every action a user can take on that page is covered, grouped the way the
 * page groups them: the fee grid (add / edit / move / re-type / remove heads,
 * scholarship, bundles), discounts, the universal scholarship setter, bundles,
 * bulk operations (add, add range, delete), transfer to another year, reset,
 * and the permission + campus-scope checks that sit in front of all of them.
 *
 * Invariants asserted (CLAUDE.md): student_fees.amount is the single source of
 * truth and always a whole number (trg_student_fees_amount_invariants);
 * discounts are their own rows (is_discount, status DISCOUNT, amount_paid 0)
 * that the grid never touches; a head on a voucher, or WAIVED, is locked.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import {
    CAMPUS_A,
    CAMPUS_B,
    CLASS_AUG,
    FEE,
    STUDENT,
    USERS,
    YEAR,
    issueVoucher,
    seedSchool,
} from './helpers/fixtures';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let as: Record<keyof typeof USERS, ReturnType<typeof client>>;

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    as = {
        admin: client(app, tokenFor(jwt, USERS.admin)),
        clerk: client(app, tokenFor(jwt, USERS.clerk)),
        viewer: client(app, tokenFor(jwt, USERS.viewer)),
        noEdit: client(app, tokenFor(jwt, USERS.noEdit)),
    };
});

afterAll(async () => {
    await app?.close();
});

// Every test starts from an empty fee schedule; the school and users stay.
beforeEach(async () => {
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "audit_logs", "deposit_allocations", "deposits", "voucher_heads", "vouchers", ' +
        '"student_fees", "student_fee_bundles", "discount_presets", "scholarship_presets" RESTART IDENTITY CASCADE',
    );
});

// ─── helpers ────────────────────────────────────────────────────────────────

const MONTH_DATE: Record<number, string> = { 8: '2026-08-01', 9: '2026-09-01', 10: '2026-10-01', 11: '2026-11-01' };

/** One grid row exactly as the page sends it (see handleSave in page.tsx). */
const item = (over: {
    id?: number;
    fee_type_id?: number;
    target_month?: number;
    amount?: number;
    fee_date?: string;
    scholarship_percentage?: number;
    scholarship_custom_title?: string;
} = {}) => {
    const tm = over.target_month ?? 8;
    const amount = over.amount ?? 18995;
    return {
        ...(over.id != null ? { id: over.id } : {}),
        fee_type_id: over.fee_type_id ?? FEE.MTF,
        month: tm,
        target_month: tm,
        amount,
        amount_before_discount: amount,
        academic_year: YEAR,
        fee_date: over.fee_date ?? MONTH_DATE[tm],
        ...(over.scholarship_percentage != null ? { scholarship_percentage: over.scholarship_percentage } : {}),
        ...(over.scholarship_custom_title ? { scholarship_custom_title: over.scholarship_custom_title } : {}),
    };
};

const save = (who: ReturnType<typeof client>, studentId: number, items: object[], extra: object = {}) =>
    who.post('/student-fees/bulk').send({ student_id: studentId, academic_year: YEAR, items, ...extra });

const heads = (studentId: number) =>
    prisma.student_fees.findMany({
        where: { student_id: studentId, is_discount: false },
        orderBy: [{ fee_type_id: 'asc' }, { target_month: 'asc' }, { id: 'asc' }],
    });

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d));
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Seed three open heads for A1 through the API and return them. */
async function seedThreeHeads() {
    const res = await save(as.admin, STUDENT.A1, [
        item({ target_month: 8 }),
        item({ target_month: 9 }),
        item({ fee_type_id: FEE.ANNUAL, target_month: 8, amount: 5000 }),
    ]);
    expect(res.status).toBe(200);
    return heads(STUDENT.A1);
}

// ─── reading the page ───────────────────────────────────────────────────────

describe('opening a student', () => {
    it('shows the class fee template when the student has no saved heads', async () => {
        const res = await as.admin.get(`/student-fees/schedule?studentId=${STUDENT.A1}&academicYear=${YEAR}`);
        expect(res.status).toBe(200);
        expect(res.body.data.is_template).toBe(true);
        const byFee = Object.fromEntries(res.body.data.fees.map((f: any) => [f.fee_id, Number(f.amount)]));
        expect(byFee).toEqual({ [FEE.MTF]: 18995, [FEE.ANNUAL]: 5000 });
    });

    it('shows the saved schedule once heads exist (both schedule routes)', async () => {
        await seedThreeHeads();
        const a = await as.admin.get(`/student-fees/schedule?studentId=${STUDENT.A1}&academicYear=${YEAR}`);
        const b = await as.admin.get(`/student-fees/student/${STUDENT.A1}/schedule?academic_year=${YEAR}`);
        for (const res of [a, b]) {
            expect(res.status).toBe(200);
            expect(res.body.data.is_template).toBe(false);
            expect(res.body.data.fees).toHaveLength(3);
        }
    });

    it('lists caution fee rows across academic years', async () => {
        await prisma.student_fees.createMany({
            data: [
                { student_id: STUDENT.A1, fee_type_id: FEE.CAUTION, academic_year: '2024-2025', target_month: 8, amount: 10000 },
                { student_id: STUDENT.A1, fee_type_id: FEE.CAUTION, academic_year: YEAR, target_month: 8, amount: 12000 },
                { student_id: STUDENT.A1, fee_type_id: FEE.MTF, academic_year: YEAR, target_month: 8, amount: 18995 },
            ],
        });
        const res = await as.admin.get(`/student-fees/caution-fee-history/${STUDENT.A1}`);
        expect(res.status).toBe(200);
        expect(res.body.data.map((r: any) => r.academic_year)).toEqual([YEAR, '2024-2025']);
    });
});

// ─── the fee grid: POST /student-fees/bulk ──────────────────────────────────

describe('fee grid: adding heads', () => {
    it('creates NOT_ISSUED heads with amount as the single source of truth', async () => {
        const rows = await seedThreeHeads();
        expect(rows).toHaveLength(3);
        for (const r of rows) {
            expect(r.status).toBe('NOT_ISSUED');
            expect(r.is_discount).toBe(false);
            expect(num(r.amount_paid)).toBe(0);
            // No scholarship: the "after discount" stage IS the final amount.
            expect(num(r.amount_after_discount)).toBe(num(r.amount));
            expect(r.term_start_month).toBe(8);
            expect(r.academic_year).toBe(YEAR);
        }
        expect(rows.map((r) => [r.fee_type_id, r.target_month, num(r.amount), ymd(r.fee_date)])).toEqual([
            [FEE.MTF, 8, 18995, '2026-08-01'],
            [FEE.MTF, 9, 18995, '2026-09-01'],
            [FEE.ANNUAL, 8, 5000, '2026-08-01'],
        ]);
    });

    it('stamps the term of the student\'s class (Apr-Mar class -> 4)', async () => {
        const res = await save(as.admin, STUDENT.A_APR, [item({ target_month: 4, fee_date: '2026-04-01' })]);
        expect(res.status).toBe(200);
        const [row] = await heads(STUDENT.A_APR);
        expect(row.term_start_month).toBe(4);
    });

    it('rounds a fractional amount to a whole number in both amount columns', async () => {
        const res = await save(as.admin, STUDENT.A1, [item({ amount: 10990.5 })]);
        expect(res.status).toBe(200);
        const [row] = await heads(STUDENT.A1);
        expect(num(row.amount)).toBe(10991);
        // The service writes 10990.50 here; only the DB trigger brings it in line.
        expect(num(row.amount_after_discount)).toBe(10991);
    });

    it('writes an audit trail for the save', async () => {
        await seedThreeHeads();
        const logs = await prisma.audit_logs.findMany({ where: { entity_type: 'STUDENT_FEE_SCHEDULE' } });
        expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['CREATED', 'UPDATED']));
        expect(logs.find((l) => l.action === 'CREATED')?.note).toMatch(/Added 3 fee row\(s\)/);
        expect(logs.every((l) => l.changed_by === USERS.admin.username)).toBe(true);
    });

    it('rejects invalid rows and writes nothing', async () => {
        const bad = [
            [item({ amount: -1 })],
            [item({ amount: 1.234 })],
            [{ ...item(), surprise: true }],
        ];
        for (const items of bad) {
            const res = await save(as.admin, STUDENT.A1, items);
            expect(res.status).toBe(400);
        }
        expect(await heads(STUDENT.A1)).toHaveLength(0);
    });

    it('404s an unknown student', async () => {
        const res = await save(as.admin, 999999, [item()]);
        expect(res.status).toBe(404);
    });
});

describe('fee grid: editing heads', () => {
    it('edits an amount in place, keeping the row id', async () => {
        const [aug, sep, annual] = await seedThreeHeads();
        const res = await save(as.admin, STUDENT.A1, [
            item({ id: aug.id, target_month: 8, amount: 20000 }),
            item({ id: sep.id, target_month: 9 }),
            item({ id: annual.id, fee_type_id: FEE.ANNUAL, target_month: 8, amount: 5000 }),
        ]);
        expect(res.status).toBe(200);
        const after = await heads(STUDENT.A1);
        expect(after.map((r) => r.id)).toEqual([aug.id, sep.id, annual.id]);
        expect(num(after[0].amount)).toBe(20000);
        expect(num(after[0].amount_after_discount)).toBe(20000);
        expect(num(after[1].amount)).toBe(18995);
        const updated = await prisma.audit_logs.findFirst({ where: { action: 'UPDATED', note: { contains: 'amount' } } });
        expect(updated?.note).toMatch(/18,?995.*20,?000/);
    });

    it('moves a fee date as an edit of the same row, never a delete-and-recreate', async () => {
        const [aug, sep, annual] = await seedThreeHeads();
        const res = await save(as.admin, STUDENT.A1, [
            item({ id: aug.id, target_month: 8, fee_date: '2026-08-15' }),
            item({ id: sep.id, target_month: 9 }),
            item({ id: annual.id, fee_type_id: FEE.ANNUAL, target_month: 8, amount: 5000 }),
        ]);
        expect(res.status).toBe(200);
        const after = await heads(STUDENT.A1);
        expect(after).toHaveLength(3);
        expect(after.find((r) => r.id === aug.id)?.fee_date && ymd(after.find((r) => r.id === aug.id)!.fee_date)).toBe('2026-08-15');
    });

    it('re-points a NOT_ISSUED row at another fee type', async () => {
        const [aug, sep, annual] = await seedThreeHeads();
        const res = await save(as.admin, STUDENT.A1, [
            item({ id: aug.id, target_month: 8 }),
            item({ id: sep.id, target_month: 9 }),
            item({ id: annual.id, fee_type_id: FEE.CAUTION, target_month: 8, amount: 5000 }),
        ]);
        expect(res.status).toBe(200);
        const row = await prisma.student_fees.findUniqueOrThrow({ where: { id: annual.id } });
        expect(row.fee_type_id).toBe(FEE.CAUTION);
    });

    it('PATCH /update-fee-dates moves dates by id', async () => {
        const [aug, sep] = await seedThreeHeads();
        const res = await as.admin.patch('/student-fees/update-fee-dates').send({
            updates: [{ id: aug.id, fee_date: '2026-08-05' }, { id: sep.id, fee_date: '2026-09-05' }],
        });
        expect(res.status).toBe(200);
        const after = await heads(STUDENT.A1);
        expect(after.filter((r) => r.fee_type_id === FEE.MTF).map((r) => ymd(r.fee_date))).toEqual(['2026-08-05', '2026-09-05']);
        expect(await prisma.audit_logs.count({ where: { field: 'fee_date' } })).toBe(1);
    });
});

describe('fee grid: removing heads', () => {
    it('deletes the heads the grid no longer sends', async () => {
        const [aug] = await seedThreeHeads();
        const res = await save(as.admin, STUDENT.A1, [item({ id: aug.id, target_month: 8 })]);
        expect(res.status).toBe(200);
        expect((await heads(STUDENT.A1)).map((r) => r.id)).toEqual([aug.id]);
        const del = await prisma.audit_logs.findFirst({ where: { action: 'DELETED' } });
        expect(del?.note).toMatch(/Removed 2 fee row\(s\)/);
    });

    it('clears the whole year when the grid is emptied', async () => {
        await seedThreeHeads();
        const res = await save(as.admin, STUDENT.A1, []);
        expect(res.status).toBe(200);
        expect(await heads(STUDENT.A1)).toHaveLength(0);
    });

    it('never deletes discount rows on a grid save', async () => {
        const [aug] = await seedThreeHeads();
        const d = await as.admin.post('/student-fees/discount').send({
            student_id: STUDENT.A1, custom_title: 'sibling', amount: 1000, target_month: 8, academic_year: YEAR,
        });
        expect(d.status).toBe(201);
        const res = await save(as.admin, STUDENT.A1, [item({ id: aug.id, target_month: 8 })]);
        expect(res.status).toBe(200);
        expect(await prisma.student_fees.count({ where: { student_id: STUDENT.A1, is_discount: true } })).toBe(1);
    });
});

describe('fee grid: locked heads', () => {
    it('a head on a voucher saves unchanged, refuses edits, and is never deleted', async () => {
        const [aug, sep, annual] = await seedThreeHeads();
        await issueVoucher(prisma, STUDENT.A1, [aug.id]);
        const unchanged = [
            item({ id: aug.id, target_month: 8 }),
            item({ id: sep.id, target_month: 9 }),
            item({ id: annual.id, fee_type_id: FEE.ANNUAL, target_month: 8, amount: 5000 }),
        ];

        expect((await save(as.admin, STUDENT.A1, unchanged)).status).toBe(200);

        const edit = await save(as.admin, STUDENT.A1, [item({ id: aug.id, target_month: 8, amount: 1 }), ...unchanged.slice(1)]);
        expect(edit.status).toBe(400);
        expect(edit.body.message).toMatch(/still have an issued voucher/);
        expect(num((await prisma.student_fees.findUniqueOrThrow({ where: { id: aug.id } })).amount)).toBe(18995);

        const omit = await save(as.admin, STUDENT.A1, unchanged.slice(1));
        expect(omit.status).toBe(200);
        expect(await prisma.student_fees.findUnique({ where: { id: aug.id } })).not.toBeNull();
    });

    it('a WAIVED head refuses edits and is never deleted', async () => {
        const [aug, sep] = await seedThreeHeads();
        await prisma.student_fees.update({ where: { id: aug.id }, data: { status: 'WAIVED', waived_amount: 18995 } });

        const edit = await save(as.admin, STUDENT.A1, [item({ id: aug.id, target_month: 8, amount: 100 }), item({ id: sep.id, target_month: 9 })]);
        expect(edit.status).toBe(400);
        expect(edit.body.message).toMatch(/waived/);

        const omit = await save(as.admin, STUDENT.A1, [item({ id: sep.id, target_month: 9 })]);
        expect(omit.status).toBe(200);
        expect((await prisma.student_fees.findUniqueOrThrow({ where: { id: aug.id } })).status).toBe('WAIVED');
    });
});

describe('fee grid: scholarship on a row', () => {
    it('applies a percentage to MTF and keeps the pre-scholarship base', async () => {
        const res = await save(as.admin, STUDENT.A1, [
            item({ scholarship_percentage: 25, scholarship_custom_title: 'merit' }),
        ]);
        expect(res.status).toBe(200);
        const [row] = await heads(STUDENT.A1);
        expect(num(row.amount)).toBe(14246); // 18,995 x 0.75 = 14,246.25 -> whole number
        expect(num(row.amount_after_discount)).toBe(18995);
        expect(num(row.scholarship_percentage)).toBe(25);
        const preset = await prisma.scholarship_presets.findUniqueOrThrow({ where: { id: row.scholarship_type_id! } });
        expect(preset.title).toBe('MERIT');
    });

    it('refuses a scholarship on anything but MTF, and rolls the whole save back', async () => {
        const res = await save(as.admin, STUDENT.A1, [
            item({ target_month: 8 }),
            item({ fee_type_id: FEE.ANNUAL, amount: 5000, scholarship_percentage: 10, scholarship_custom_title: 'x' }),
        ]);
        expect(res.status).toBe(400);
        expect(await heads(STUDENT.A1)).toHaveLength(0);
    });
});

describe('fee grid: bundles saved with the grid', () => {
    it('groups heads by fee key, keeps the total in sync, and drops an emptied bundle', async () => {
        const res = await save(as.admin, STUDENT.A1, [item({ target_month: 8 }), item({ fee_type_id: FEE.ANNUAL, target_month: 8, amount: 5000 })], {
            bundles: [{ bundle_name: 'AUGUST PACK', target_month: 8, academic_year: YEAR, fee_keys: [`${FEE.MTF}|8|2026-08-01`, `${FEE.ANNUAL}|8|2026-08-01`] }],
        });
        expect(res.status).toBe(200);
        const [bundle] = await prisma.student_fee_bundles.findMany({ where: { student_id: STUDENT.A1 } });
        expect(num(bundle.total_amount)).toBe(23995);
        const [mtf, annual] = await heads(STUDENT.A1);
        expect([mtf.bundle_id, annual.bundle_id]).toEqual([bundle.id, bundle.id]);

        // Drop the annual charge: the bundle total follows.
        expect((await save(as.admin, STUDENT.A1, [item({ id: mtf.id, target_month: 8 })])).status).toBe(200);
        expect(num((await prisma.student_fee_bundles.findUniqueOrThrow({ where: { id: bundle.id } })).total_amount)).toBe(18995);

        // Drop the last member: the bundle goes too.
        expect((await save(as.admin, STUDENT.A1, [])).status).toBe(200);
        expect(await prisma.student_fee_bundles.count()).toBe(0);
    });
});

// ─── discounts ──────────────────────────────────────────────────────────────

describe('discounts', () => {
    const discount = (over: object = {}) => ({
        student_id: STUDENT.A1, custom_title: 'sibling discount', amount: 2500, fee_date: '2026-08-01', target_month: 8, academic_year: YEAR, ...over,
    });

    it('adds a discount as its own row: is_discount, DISCOUNT, nothing paid, no fee type', async () => {
        const res = await as.admin.post('/student-fees/discount').send(discount());
        expect(res.status).toBe(201);
        const row = await prisma.student_fees.findUniqueOrThrow({ where: { id: res.body.data.id } });
        expect(row).toMatchObject({ is_discount: true, status: 'DISCOUNT', fee_type_id: null, target_month: 8, term_start_month: 8 });
        expect(num(row.amount_paid)).toBe(0);
        // Stored as a positive magnitude; issuance writes it to voucher_heads negated.
        expect(num(row.amount)).toBe(2500);
        const preset = await prisma.discount_presets.findUniqueOrThrow({ where: { id: row.discount_type_id! } });
        expect(preset.title).toBe('SIBLING DISCOUNT');
    });

    it('reuses an existing preset by id', async () => {
        const preset = await prisma.discount_presets.create({ data: { title: 'STAFF CHILD', is_active: true } });
        const res = await as.admin.post('/student-fees/discount').send(discount({ custom_title: undefined, discount_type_id: preset.id }));
        expect(res.status).toBe(201);
        expect(res.body.data.discount_type_id).toBe(preset.id);
        expect(await prisma.discount_presets.count()).toBe(1);
    });

    it('rejects a zero, negative or untitled discount', async () => {
        for (const bad of [discount({ amount: 0 }), discount({ amount: -5 }), discount({ custom_title: undefined }), discount({ fee_date: '01/08/2026' })]) {
            expect((await as.admin.post('/student-fees/discount').send(bad)).status).toBe(400);
        }
        expect(await prisma.student_fees.count()).toBe(0);
    });

    it('removes a discount row, but never a regular head or one on a voucher', async () => {
        const [aug] = await seedThreeHeads();
        const a = (await as.admin.post('/student-fees/discount').send(discount())).body.data.id;
        const b = (await as.admin.post('/student-fees/discount').send(discount({ amount: 100 }))).body.data.id;
        await issueVoucher(prisma, STUDENT.A1, [aug.id, b]);

        expect((await as.admin.delete(`/student-fees/discount/${a}`)).status).toBe(200);
        expect(await prisma.student_fees.findUnique({ where: { id: a } })).toBeNull();

        const regular = await as.admin.delete(`/student-fees/discount/${aug.id}`);
        expect(regular.status).toBe(400);
        expect(regular.body.message).toMatch(/not a discount row/);

        const onVoucher = await as.admin.delete(`/student-fees/discount/${b}`);
        expect(onVoucher.status).toBe(400);
        expect(onVoucher.body.message).toMatch(/included in a voucher/);
        // The voucher carries the discount at a negative net amount.
        const vh = await prisma.voucher_heads.findFirstOrThrow({ where: { student_fee_id: b } });
        expect(num(vh.net_amount)).toBe(-100);
    });
});

// ─── universal scholarship setter ───────────────────────────────────────────

describe('apply scholarship to a whole year', () => {
    it('sets the percentage on every open MTF row and reports the locked ones', async () => {
        const [aug, sep, annual] = await seedThreeHeads();
        await issueVoucher(prisma, STUDENT.A1, [aug.id]);

        const res = await as.admin.post('/student-fees/apply-scholarship').send({
            student_id: STUDENT.A1, academic_year: YEAR, scholarship_percentage: 50, custom_title: 'need based',
        });
        expect(res.status).toBe(200);
        expect(res.body.data.updated).toBe(1);
        expect(res.body.data.skipped).toEqual([expect.objectContaining({ id: aug.id, reason: 'on a voucher' })]);

        const rows = Object.fromEntries((await heads(STUDENT.A1)).map((r) => [r.id, r]));
        expect(num(rows[sep.id].amount)).toBe(9498); // 18,995 x 0.5 = 9,497.5 -> whole number
        expect(num(rows[sep.id].amount_after_discount)).toBe(18995);
        expect(num(rows[aug.id].amount)).toBe(18995); // on a voucher: untouched
        expect(num(rows[annual.id].amount)).toBe(5000); // not MTF: untouched
        expect(rows[annual.id].scholarship_percentage).toBeNull();
    });

    it('refuses when every MTF month is already issued', async () => {
        const [aug, sep] = await seedThreeHeads();
        await issueVoucher(prisma, STUDENT.A1, [aug.id, sep.id]);
        const res = await as.admin.post('/student-fees/apply-scholarship').send({
            student_id: STUDENT.A1, academic_year: YEAR, scholarship_percentage: 50, custom_title: 'x',
        });
        expect(res.status).toBe(400);
    });
});

// ─── bundles ────────────────────────────────────────────────────────────────

describe('bundles', () => {
    it('creates, lists, renames and dissolves a bundle', async () => {
        const [aug, sep, annual] = await seedThreeHeads();
        const created = await as.admin.post('/student-fees/bundles').send({
            student_id: STUDENT.A1, bundle_name: 'TERM 1', target_month: 8, academic_year: YEAR,
            fee_ids: [aug.id, annual.id], fee_date_overrides: [{ id: annual.id, fee_date: '2026-08-10' }],
        });
        expect(created.status).toBe(201);
        const id = created.body.data.id;
        expect(num(created.body.data.total_amount)).toBe(23995);
        expect(ymd((await prisma.student_fees.findUniqueOrThrow({ where: { id: annual.id } })).fee_date)).toBe('2026-08-10');

        const list = await as.admin.get(`/student-fees/bundles/${STUDENT.A1}`);
        expect(list.status).toBe(200);
        expect(list.body.data[0].student_fees.map((f: any) => f.id).sort()).toEqual([aug.id, annual.id].sort());

        expect((await as.admin.patch(`/student-fees/bundles/${id}`).send({ bundle_name: 'TERM ONE' })).status).toBe(200);
        expect((await prisma.student_fee_bundles.findUniqueOrThrow({ where: { id } })).bundle_name).toBe('TERM ONE');

        expect((await as.admin.delete(`/student-fees/bundles/${id}`)).status).toBe(200);
        expect(await prisma.student_fee_bundles.count()).toBe(0);
        // Members survive the bundle.
        expect((await heads(STUDENT.A1)).map((r) => r.id)).toEqual([aug.id, sep.id, annual.id]);
    });

    it('refuses a bundle with another student\'s head', async () => {
        const [aug] = await seedThreeHeads();
        await save(as.admin, STUDENT.A2, [item()]);
        const [other] = await heads(STUDENT.A2);
        const res = await as.admin.post('/student-fees/bundles').send({
            student_id: STUDENT.A1, bundle_name: 'X', academic_year: YEAR, fee_ids: [aug.id, other.id],
        });
        expect(res.status).toBe(400);
    });
});

// ─── bulk operations drawer ─────────────────────────────────────────────────

describe('bulk operations', () => {
    const scope = `campus_id=${CAMPUS_A}&class_id=${CLASS_AUG}&academic_year=${YEAR}`;

    it('previews and adds one head to a class', async () => {
        await save(as.admin, STUDENT.A2, [item({ fee_type_id: FEE.ANNUAL, amount: 5000 })]);
        const preview = await as.admin.get(`/student-fees/bulk-preview?${scope}&fee_type_id=${FEE.ANNUAL}&fee_date=2026-08-01`);
        expect(preview.status).toBe(200);
        // Campus A, Aug-Jul class only: not the Apr-Mar student, not campus B.
        expect(preview.body.data).toMatchObject({ total: 2, will_add: 1, already_exists: 1 });
        const willAdd = preview.body.data.students.filter((s: any) => s.status === 'will_add').map((s: any) => s.student_id);
        expect(willAdd).toEqual([STUDENT.A1]);

        const add = await as.admin.post('/student-fees/bulk-add').send({
            academic_year: YEAR, fee_type_id: FEE.ANNUAL, month: 8, fee_date: '2026-08-01', amount: 5000, student_ids: willAdd,
        });
        expect(add.status).toBe(200);
        expect(add.body.data.added).toBe(1);
        const [row] = await heads(STUDENT.A1);
        expect(row).toMatchObject({ fee_type_id: FEE.ANNUAL, target_month: 8, status: 'NOT_ISSUED', term_start_month: 8 });
        expect([num(row.amount), num(row.amount_before_discount), num(row.amount_after_discount)]).toEqual([5000, 5000, 5000]);
    });

    it('adds a range of months, skipping a day the month does not have', async () => {
        const conflicts = await as.admin.get(`/student-fees/bulk-add-range-conflicts?${scope}&fee_type_id=${FEE.MTF}&start_month=8&end_month=10&day=31`);
        expect(conflicts.status).toBe(200);
        expect(conflicts.body.data.months.map((m: any) => m.valid)).toEqual([true, false, true]);

        const res = await as.admin.post('/student-fees/bulk-add-range').send({
            academic_year: YEAR, fee_type_id: FEE.MTF, start_month: 8, end_month: 10, day: 31, amount: 18995, student_ids: [STUDENT.A1, STUDENT.A2],
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ total_added: 4, total_skipped: 0 });
        expect(res.body.data.summary[1]).toEqual({ month: 9, skipped_reason: 'day_invalid' });
        expect((await heads(STUDENT.A1)).map((r) => ymd(r.fee_date))).toEqual(['2026-08-31', '2026-10-31']);
    });

    it('bulk deletes free heads and blocks the ones on a voucher', async () => {
        await save(as.admin, STUDENT.A1, [item()]);
        await save(as.admin, STUDENT.A2, [item()]);
        const [a1] = await heads(STUDENT.A1);
        await issueVoucher(prisma, STUDENT.A1, [a1.id]);

        const preview = await as.admin.get(`/student-fees/bulk-delete-preview?${scope}&fee_date=2026-08-01`);
        expect(preview.status).toBe(200);
        expect(preview.body.data).toMatchObject({ total: 2, can_delete: 1, blocked: 1 });

        const range = await as.admin.get(`/student-fees/bulk-delete-range-preview?${scope}&start_month=8&end_month=9&day=1`);
        expect(range.status).toBe(200);

        const res = await as.admin.delete('/student-fees/bulk-delete').send({ student_fee_ids: preview.body.data.rows.map((r: any) => r.id) });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ deleted: 1, blocked: 1 });
        expect(await heads(STUDENT.A2)).toHaveLength(0);
        expect(await heads(STUDENT.A1)).toHaveLength(1);
    });
});

// ─── transfer heads to another academic year (admin only) ───────────────────

describe('transfer heads to another year', () => {
    it('previews, demands acknowledgement, then rewrites academic_year and term together', async () => {
        const [aug, sep] = await seedThreeHeads();
        const ids = `${aug.id},${sep.id}`;
        const preview = await as.admin.get(`/student-fees/transfer-preview?student_fee_ids=${ids}&target_academic_year=2027-2028&target_term_start_month=4`);
        expect(preview.status).toBe(200);
        expect(preview.body.data.total).toBe(2);

        const body = { student_fee_ids: [aug.id, sep.id], target_academic_year: '2027-2028', target_term_start_month: 4 };
        expect((await as.admin.patch('/student-fees/transfer').send(body)).status).toBe(400);

        const res = await as.admin.patch('/student-fees/transfer').send({ ...body, acknowledgement: true });
        expect(res.status).toBe(200);
        expect(res.body.data.transferred).toBe(2);
        const moved = await prisma.student_fees.findMany({ where: { id: { in: [aug.id, sep.id] } } });
        expect(moved.every((r) => r.academic_year === '2027-2028' && r.term_start_month === 4)).toBe(true);
    });

    it('is refused to anyone but a super admin', async () => {
        const [aug] = await seedThreeHeads();
        const res = await as.clerk.patch('/student-fees/transfer').send({
            student_fee_ids: [aug.id], target_academic_year: '2027-2028', target_term_start_month: 4, acknowledgement: true,
        });
        expect(res.status).toBe(403);
    });
});

// ─── reset every head (admin only, danger zone) ─────────────────────────────

describe('reset all heads', () => {
    it('deletes vouchers and deposits and returns every head to NOT_ISSUED', async () => {
        const [aug, sep] = await seedThreeHeads();
        const voucherId = await issueVoucher(prisma, STUDENT.A1, [aug.id, sep.id]);
        await prisma.deposits.create({ data: { student_id: STUDENT.A1, total_amount: 1000 } });
        expect(voucherId).toBeGreaterThan(0);
        await prisma.student_fees.update({ where: { id: aug.id }, data: { status: 'PARTIALLY_PAID', amount_paid: 1000 } });

        expect((await as.clerk.delete(`/student-fees/reset/${STUDENT.A1}`)).status).toBe(403);

        const res = await as.admin.delete(`/student-fees/reset/${STUDENT.A1}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ deletedDeposits: 1, deletedVouchers: 1, resetFees: 2 });
        const after = await heads(STUDENT.A1);
        expect(after).toHaveLength(3);
        expect(after.every((r) => r.status === 'NOT_ISSUED' && num(r.amount_paid) === 0)).toBe(true);
        expect(await prisma.voucher_heads.count()).toBe(0);
    });
});

// ─── who may do what ────────────────────────────────────────────────────────

describe('permissions', () => {
    it('401s without a token', async () => {
        const res = await request(app.getHttpServer()).get(`/api/v1/student-fees/schedule?studentId=${STUDENT.A1}&academicYear=${YEAR}`);
        expect(res.status).toBe(401);
    });

    it('a view-only holder can read but not save', async () => {
        expect((await as.viewer.get(`/student-fees/schedule?studentId=${STUDENT.A1}&academicYear=${YEAR}`)).status).toBe(200);
        expect((await save(as.viewer, STUDENT.A1, [item()])).status).toBe(403);
        expect((await as.viewer.post('/student-fees/discount').send({
            student_id: STUDENT.A1, custom_title: 'x', amount: 1, target_month: 8, academic_year: YEAR,
        })).status).toBe(403);
        expect(await heads(STUDENT.A1)).toHaveLength(0);
    });

    it('a denied schedule.edit blocks the grid even when CASL would allow it', async () => {
        const res = await save(as.noEdit, STUDENT.A1, [item()]);
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/finance\.student_overrides#schedule\.edit/);
        expect(await heads(STUDENT.A1)).toHaveLength(0);
        // ...while the actions it still holds work.
        const d = await as.noEdit.post('/student-fees/discount').send({
            student_id: STUDENT.A1, custom_title: 'x', amount: 1, target_month: 8, academic_year: YEAR,
        });
        expect(d.status).toBe(201);
    });
});

describe('campus scope (clerk scoped to campus A)', () => {
    it('works normally on a student in scope', async () => {
        expect((await save(as.clerk, STUDENT.A1, [item()])).status).toBe(200);
        expect(await heads(STUDENT.A1)).toHaveLength(1);
    });

    it('sees a student outside scope as not found, on every per-student route', async () => {
        await save(as.admin, STUDENT.B1, [item()]);
        const [b1] = await heads(STUDENT.B1);
        const discountB = (await as.admin.post('/student-fees/discount').send({
            student_id: STUDENT.B1, custom_title: 'x', amount: 1, target_month: 8, academic_year: YEAR,
        })).body.data.id;

        const attempts: [string, () => Promise<{ status: number }>][] = [
            ['schedule', () => as.clerk.get(`/student-fees/schedule?studentId=${STUDENT.B1}&academicYear=${YEAR}`)],
            ['caution fee history', () => as.clerk.get(`/student-fees/caution-fee-history/${STUDENT.B1}`)],
            ['bundles', () => as.clerk.get(`/student-fees/bundles/${STUDENT.B1}`)],
            ['grid save', () => save(as.clerk, STUDENT.B1, [item({ id: b1.id, amount: 1 })])],
            ['update fee dates', () => as.clerk.patch('/student-fees/update-fee-dates').send({ updates: [{ id: b1.id, fee_date: '2026-08-20' }] })],
            ['add discount', () => as.clerk.post('/student-fees/discount').send({ student_id: STUDENT.B1, custom_title: 'x', amount: 1, target_month: 8, academic_year: YEAR })],
            ['delete discount', () => as.clerk.delete(`/student-fees/discount/${discountB}`)],
            ['apply scholarship', () => as.clerk.post('/student-fees/apply-scholarship').send({ student_id: STUDENT.B1, academic_year: YEAR, scholarship_percentage: 10, custom_title: 'x' })],
            ['bulk add', () => as.clerk.post('/student-fees/bulk-add').send({ academic_year: YEAR, fee_type_id: FEE.ANNUAL, month: 8, fee_date: '2026-08-01', amount: 1, student_ids: [STUDENT.B1] })],
            ['bulk delete', () => as.clerk.delete('/student-fees/bulk-delete').send({ student_fee_ids: [b1.id] })],
        ];
        for (const [route, attempt] of attempts) {
            const res = await attempt();
            expect({ route, status: res.status }).toEqual({ route, status: 404 });
        }

        // Nothing of B1's moved.
        const after = await prisma.student_fees.findMany({ where: { student_id: STUDENT.B1 } });
        expect(after).toHaveLength(2);
        const head = after.find((r) => r.id === b1.id)!;
        expect([num(head.amount), ymd(head.fee_date)]).toEqual([18995, '2026-08-01']);
    });

    it('refuses a bulk operation on another campus outright', async () => {
        const res = await as.clerk.get(`/student-fees/bulk-preview?campus_id=${CAMPUS_B}&academic_year=${YEAR}&fee_type_id=${FEE.MTF}&fee_date=2026-08-01`);
        expect(res.status).toBe(403);
    });
});

// ─── the database layer itself ──────────────────────────────────────────────

describe('trg_student_fees_amount_invariants', () => {
    it('keeps amount whole on any write path, not just the service', async () => {
        const row = await prisma.student_fees.create({
            data: { student_id: STUDENT.A1, fee_type_id: FEE.MTF, academic_year: YEAR, target_month: 8, amount: new Prisma.Decimal('100.40') },
        });
        expect(num(row.amount)).toBe(100);
        expect(num(row.amount_after_discount)).toBe(100);

        const updated = await prisma.student_fees.update({ where: { id: row.id }, data: { amount: new Prisma.Decimal('250.60') } });
        expect(num(updated.amount)).toBe(251);
        expect(num(updated.amount_after_discount)).toBe(251);
    });

    it('leaves the pre-scholarship base alone when a scholarship is set', async () => {
        const row = await prisma.student_fees.create({
            data: {
                student_id: STUDENT.A1, fee_type_id: FEE.MTF, academic_year: YEAR, target_month: 8,
                amount: new Prisma.Decimal('14246.25'), amount_after_discount: new Prisma.Decimal(18995), scholarship_percentage: 25,
            },
        });
        expect(num(row.amount)).toBe(14246);
        expect(num(row.amount_after_discount)).toBe(18995);
    });
});
