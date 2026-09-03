// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively through the students service. Stub that boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
    VoucherPdfService: class { },
}));

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StudentFeesService } from './student-fees.service';
import { resetClassTermMapCache } from '../../common/utils/class-terms.util';

/**
 * Row identity in the studentwise-fees bulk save.
 *
 * The rule under test: a row is identified by its id, not by its field values.
 * Before that, identity was (fee_type_id|target_month|academic_year|fee_date) —
 * which put fee_date *inside* the key, so moving a row's date was structurally
 * indistinguishable from "delete this row, add a different one". It only looked
 * like an edit because the stale row usually got deleted; when it couldn't be
 * (voucher- or installment-linked, or its key still claimed by its split twin)
 * the row was duplicated instead of moved.
 *
 * Fixture mirrors the reported case: a MONTHLY TUITION FEE for September that
 * was partially paid and split, leaving a PARTIAL half and a BALANCE half that
 * share every keyed field and differ only by description_prefix.
 */
describe('StudentFeesService bulkSave row identity', () => {
    const YEAR = '2026-2027';
    const dec = (n: number) => new Prisma.Decimal(n) as any;

    const row = (over: Partial<Record<string, any>> = {}) => ({
        id: 0,
        student_id: 4051,
        fee_type_id: 1,
        month: 9,
        target_month: 9,
        academic_year: YEAR,
        fee_date: new Date('2026-08-01T00:00:00.000Z'),
        amount: dec(10990),
        amount_after_discount: dec(10990),
        amount_before_discount: dec(10990),
        scholarship_percentage: null,
        description_prefix: null,
        split_pair_id: null,
        bundle_id: null,
        installment_id: null,
        is_discount: false,
        voucher_heads: [] as any[],
        ...over,
    });

    // The two halves left behind by splitPartiallyPaid: identical in every field
    // the old composite key looked at.
    const PARTIAL = row({
        id: 8411,
        description_prefix: 'PARTIAL PAYMENT OF — MONTHLY TUITION FEE',
        split_pair_id: null,
        voucher_heads: [{ id: 55 }],   // still on a PAID voucher
    });
    const BALANCE = row({
        id: 8412,
        description_prefix: 'BALANCE PAYMENT OF — MONTHLY TUITION FEE',
        split_pair_id: 8411,
        voucher_heads: [],             // its voucher was deleted → row is free
    });

    // What the grid sends for a row, mirroring handleSave's payload shape.
    const item = (r: any, over: Partial<Record<string, any>> = {}) => ({
        id: r.id,
        fee_type_id: r.fee_type_id,
        month: r.month,
        target_month: r.target_month,
        amount: Number(r.amount_after_discount),
        amount_before_discount: Number(r.amount_before_discount),
        academic_year: YEAR,
        fee_date: r.fee_date ? r.fee_date.toISOString().split('T')[0] : undefined,
        ...over,
    });

    const build = (existing: any[]) => {
        const updates: any[] = [];
        const creates: any[] = [];
        const deletes: number[] = [];

        const tx: any = {
            student_fees: {
                findMany: jest.fn().mockResolvedValue(existing),
                deleteMany: jest.fn().mockImplementation((args: any) => {
                    deletes.push(...args.where.id.in);
                    return Promise.resolve({ count: args.where.id.in.length });
                }),
                update: jest.fn().mockImplementation((args: any) => {
                    updates.push({ id: args.where.id, ...args.data });
                    return Promise.resolve({ id: args.where.id });
                }),
                create: jest.fn().mockImplementation((args: any) => {
                    creates.push(args.data);
                    return Promise.resolve({ id: 9999 });
                }),
            },
            fee_types: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 1, description: 'MONTHLY TUITION FEE' },
                    { id: 4, description: 'ANNUAL FEE' },
                ]),
            },
            student_fee_bundles: { findMany: jest.fn().mockResolvedValue([]) },
        };

        const prisma: any = {
            students: { findUnique: jest.fn().mockResolvedValue({ cc: 4051, class_id: 11 }) },
            classes: { findMany: jest.fn().mockResolvedValue([{ id: 11, term_start_month: 8 }]) },
            $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
        };
        const auditLogs: any = { log: jest.fn(), logGroup: jest.fn() };
        const service = new StudentFeesService(prisma, auditLogs, {} as any);
        return { service, updates, creates, deletes };
    };

    beforeEach(() => resetClassTermMapCache());

    it('moves a freed BALANCE head to a new fee_date instead of duplicating it', async () => {
        const { service, updates, creates, deletes } = build([PARTIAL, BALANCE]);

        await service.bulkSave({
            student_id: 4051,
            academic_year: YEAR,
            items: [
                item(PARTIAL),
                item(BALANCE, { fee_date: '2026-09-01' }),
            ],
        } as any);

        // The whole bug: no second MONTHLY TUITION FEE row, nothing deleted.
        expect(creates).toEqual([]);
        expect(deletes).toEqual([]);

        // The BALANCE row itself moved, and the update never touches
        // description_prefix or split_pair_id — that is what keeps the prefix.
        const moved = updates.find((u) => u.id === BALANCE.id);
        expect(moved.fee_date).toEqual(new Date('2026-09-01'));
        expect(moved).not.toHaveProperty('description_prefix');
        expect(moved).not.toHaveProperty('split_pair_id');
        expect(moved).not.toHaveProperty('status');
    });

    it('updates both halves of a split separately even though their keys collide', async () => {
        const { service, updates } = build([PARTIAL, BALANCE]);

        await service.bulkSave({
            student_id: 4051,
            academic_year: YEAR,
            items: [item(PARTIAL), item(BALANCE)],
        } as any);

        // Under key-matching both halves resolved to one id and raced on it.
        expect(updates.map((u) => u.id).sort()).toEqual([8411, 8412]);
    });

    it('deletes a row the user removed even when a surviving row shares its key', async () => {
        const { service, deletes, creates } = build([PARTIAL, BALANCE]);

        // BALANCE dropped from the grid; PARTIAL still carries the shared key.
        await service.bulkSave({
            student_id: 4051,
            academic_year: YEAR,
            items: [item(PARTIAL)],
        } as any);

        expect(deletes).toEqual([BALANCE.id]);
        expect(creates).toEqual([]);
    });

    it('creates a row the grid could not tag, and leaves tagged rows alone', async () => {
        const { service, updates, creates, deletes } = build([BALANCE]);

        await service.bulkSave({
            student_id: 4051,
            academic_year: YEAR,
            items: [
                item(BALANCE),
                // A row the user just added: no id yet.
                { fee_type_id: 4, month: 10, target_month: 10, amount: 5000, amount_before_discount: 5000, academic_year: YEAR, fee_date: '2026-10-01' },
            ],
        } as any);

        expect(deletes).toEqual([]);
        expect(updates.map((u) => u.id)).toEqual([BALANCE.id]);
        expect(creates).toHaveLength(1);
        expect(creates[0]).toMatchObject({ fee_type_id: 4, target_month: 10, status: 'NOT_ISSUED' });
    });

    it('rejects an edit to a head that still has an issued voucher', async () => {
        const { service } = build([PARTIAL, BALANCE]);

        await expect(service.bulkSave({
            student_id: 4051,
            academic_year: YEAR,
            items: [
                item(PARTIAL, { amount: 12000 }),   // PARTIAL is still voucher-linked
                item(BALANCE),
            ],
        } as any)).rejects.toThrow(BadRequestException);
    });

    it('still saves a voucher-linked head that was resent unchanged', async () => {
        const { service, updates, creates, deletes } = build([PARTIAL, BALANCE]);

        await service.bulkSave({
            student_id: 4051,
            academic_year: YEAR,
            items: [item(PARTIAL), item(BALANCE)],
        } as any);

        expect(updates).toHaveLength(2);
        expect(creates).toEqual([]);
        expect(deletes).toEqual([]);
    });

    it('persists a fee-type change on an id-matched row instead of reverting it', async () => {
        // BALANCE is a free (non-voucher) MONTHLY TUITION FEE row. The grid lets
        // the user re-point it at a different fee type; the payload keeps the row
        // id, so Pass A matches by id and takes the update path — which must
        // carry the new fee_type_id through or the change silently reverts to
        // MTF on the post-save refetch.
        const { service, updates, creates, deletes } = build([BALANCE]);

        await service.bulkSave({
            student_id: 4051,
            academic_year: YEAR,
            items: [item(BALANCE, { fee_type_id: 4 })],
        } as any);

        expect(creates).toEqual([]);
        expect(deletes).toEqual([]);
        const changed = updates.find((u) => u.id === BALANCE.id);
        expect(changed.fee_type_id).toBe(4);
    });

    it('falls back to key matching for a payload that carries no ids', async () => {
        const { service, updates, creates } = build([BALANCE]);

        await service.bulkSave({
            student_id: 4051,
            academic_year: YEAR,
            items: [item(BALANCE, { id: undefined })],
        } as any);

        expect(creates).toEqual([]);
        expect(updates.map((u) => u.id)).toEqual([BALANCE.id]);
    });
});
