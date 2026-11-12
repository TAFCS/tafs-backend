import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import {
    FAMILY_CREDIT_KIND,
    FAMILY_CREDIT_KIND_LABEL,
    MANUAL_FAMILY_CREDIT_KINDS,
    assertBalanceCovers,
    assertManualAmount,
    assertReason,
    hasOpenCreditEntries,
    rowsToUndo,
    sumLedger,
    undoEntries,
} from '../vouchers/family-credit';
import { FamilyCreditController } from './family-credit.controller';
import { TILES_MANIFEST } from '../access/tiles.manifest';
import { REQUIRE_ACTION_KEY, type RequireActionMetadata } from '../../decorators/require-action.decorator';

/**
 * TAFSD-504: the Family Credit tile's manual entries. The ledger rules are pure
 * functions in vouchers/family-credit.ts; this checks them and that every route
 * is gated on its own action.
 */
describe('family credit manual entries (TAFSD-504)', () => {
    const row = (id: number, family_id: number, amount: number, kind: string, linked_entry_id: number | null = null) =>
        ({ id, family_id, amount, kind, linked_entry_id });

    describe('assertManualAmount', () => {
        it('accepts rupees and paisa', () => {
            expect(assertManualAmount(5000).toString()).toBe('5000');
            expect(assertManualAmount('12.5').toString()).toBe('12.5');
        });
        it.each([0, -1, 1.234, 200_000_000])('refuses %p', (v) => {
            expect(() => assertManualAmount(v)).toThrow();
        });
    });

    describe('assertReason', () => {
        it('trims and keeps a real reason', () => {
            expect(assertReason('  Opening balance  ')).toBe('Opening balance');
        });
        it.each(['', '  ', 'ok', null, undefined])('refuses %p', (v) => {
            expect(() => assertReason(v as any)).toThrow(/reason/);
        });
    });

    describe('assertBalanceCovers', () => {
        it('allows taking out exactly the balance', () => {
            expect(() => assertBalanceCovers(10000, 10000)).not.toThrow();
        });
        it('never lets the balance go below zero', () => {
            expect(() => assertBalanceCovers(10000, 10000.01)).toThrow(/below zero/);
            expect(() => assertBalanceCovers(0, 1)).toThrow(/below zero/);
        });
    });

    describe('rowsToUndo', () => {
        it('a single manual entry undoes alone', () => {
            const r = row(5, 1, 3000, FAMILY_CREDIT_KIND.MANUAL_CREDIT);
            expect(rowsToUndo(r, null)).toEqual([r]);
        });
        it.each([
            FAMILY_CREDIT_KIND.EXCESS_DEPOSIT,
            FAMILY_CREDIT_KIND.APPLIED_TO_VOUCHER,
            FAMILY_CREDIT_KIND.EXCESS_REVERSED,
            FAMILY_CREDIT_KIND.APPLICATION_REVERSED,
        ])('refuses a deposit entry (%s): reverse the deposit instead', (kind) => {
            expect(() => rowsToUndo(row(1, 1, 100, kind), null)).toThrow(/Reverse the deposit/);
        });
        it('refuses to undo an undo', () => {
            expect(() => rowsToUndo(row(1, 1, 100, FAMILY_CREDIT_KIND.ENTRY_REVERSED), null)).toThrow(/itself an undo/);
        });
        it('a transfer is undone as a pair from either side', () => {
            const out = row(10, 1, -4000, FAMILY_CREDIT_KIND.TRANSFER_OUT);
            const into = row(11, 2, 4000, FAMILY_CREDIT_KIND.TRANSFER_IN, 10);
            expect(rowsToUndo(out, into)).toEqual([out, into]);
            expect(rowsToUndo(into, out)).toEqual([out, into]);
        });
        it('refuses a transfer whose other half is missing or does not match', () => {
            const out = row(10, 1, -4000, FAMILY_CREDIT_KIND.TRANSFER_OUT);
            expect(() => rowsToUndo(out, null)).toThrow(/other half/);
            expect(() => rowsToUndo(out, row(12, 2, 4000, FAMILY_CREDIT_KIND.TRANSFER_IN, 99))).toThrow(/does not match/);
        });
    });

    describe('undoEntries', () => {
        const bal = (entries: Array<[number, number]>) => new Map(entries.map(([k, v]) => [k, new Prisma.Decimal(v)]));

        it('undoing a deduction or refund gives the money back whatever the balance', () => {
            const out = undoEntries([row(1, 1, -2500, FAMILY_CREDIT_KIND.REFUNDED)], bal([[1, 0]]));
            expect(out.map((o) => [o.family_id, o.amount.toString(), o.reverses_entry_id])).toEqual([[1, '2500', 1]]);
        });
        it('undoing an added credit is refused once it has been spent', () => {
            expect(() => undoEntries([row(1, 1, 5000, FAMILY_CREDIT_KIND.MANUAL_CREDIT)], bal([[1, 4999]]))).toThrow(/below zero/);
            expect(undoEntries([row(1, 1, 5000, FAMILY_CREDIT_KIND.MANUAL_CREDIT)], bal([[1, 5000]]))[0].amount.toString()).toBe('-5000');
        });
        it('undoing a transfer takes it back from the receiving family, refused if they used it', () => {
            const pair = [row(10, 1, -4000, FAMILY_CREDIT_KIND.TRANSFER_OUT), row(11, 2, 4000, FAMILY_CREDIT_KIND.TRANSFER_IN, 10)];
            const ok = undoEntries(pair, bal([[1, 0], [2, 4000]]));
            expect(ok.map((o) => [o.family_id, o.amount.toString()])).toEqual([[1, '4000'], [2, '-4000']]);
            expect(() => undoEntries(pair, bal([[1, 0], [2, 3000]]))).toThrow(/family #2 below zero/);
        });
    });

    describe('the ledger still sums and deposit checks ignore manual rows', () => {
        it('a full manual history sums to the balance', () => {
            const rows = [
                { amount: 10000 }, // MANUAL_CREDIT
                { amount: -2000 }, // MANUAL_DEBIT
                { amount: -3000 }, // REFUNDED
                { amount: -1000 }, // TRANSFER_OUT
                { amount: 2000 }, // ENTRY_REVERSED of the debit
            ];
            expect(sumLedger(rows).toString()).toBe('6000');
        });
        it('manual rows carry no deposit, so fee reset / student delete are not blocked by them', () => {
            expect(hasOpenCreditEntries([{ deposit_id: null, amount: 5000 }])).toBe(false);
        });
        it('every kind has a label', () => {
            for (const k of Object.values(FAMILY_CREDIT_KIND)) expect(FAMILY_CREDIT_KIND_LABEL[k]).toBeTruthy();
            expect(MANUAL_FAMILY_CREDIT_KINDS).not.toContain(FAMILY_CREDIT_KIND.ENTRY_REVERSED);
        });
    });

    describe('Family Credit tile and routes', () => {
        const tile = TILES_MANIFEST.find((t) => t.id === 'finance.family_credit')!;

        it('is its own finance tile with view as the only default and no legacy bridge', () => {
            expect(tile.module).toBe('finance');
            expect(tile.href).toBe('/family-credit');
            expect(tile.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
            expect(tile.legacyFullAccessCapabilities).toBeUndefined();
        });

        const expected: Record<string, string> = {
            list: 'view',
            searchSimple: 'view',
            detail: 'view',
            export: 'export',
            add: 'add',
            deduct: 'deduct',
            refund: 'refund',
            transfer: 'transfer',
            undo: 'undo',
        };
        it.each(Object.entries(expected))('%s requires finance.family_credit#%s', (handler, action) => {
            const meta: RequireActionMetadata = Reflect.getMetadata(
                REQUIRE_ACTION_KEY,
                (FamilyCreditController.prototype as any)[handler],
            );
            expect(meta.actionKeys).toEqual([`finance.family_credit#${action}`]);
            expect(tile.actions!.some((a) => a.id === action)).toBe(true);
        });
        it('every route on the controller is covered above', () => {
            const handlers = Object.getOwnPropertyNames(FamilyCreditController.prototype).filter((n) => n !== 'constructor');
            expect(handlers.sort()).toEqual(Object.keys(expected).sort());
        });
    });
});
