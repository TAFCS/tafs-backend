import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Family credit (TAFSD-421): money a family has paid beyond its vouchers, held
 * at the family level so a sibling can use it.
 *
 * `family_credit_ledger` is append-only and the balance is always the sum of its
 * rows. Nothing is ever edited or deleted: undoing an entry adds an opposite row.
 *
 * Two deposit columns keep every money figure honest (see backend CLAUDE.md,
 * Rule E):
 *   - `excess_amount`: part of the cash in `total_amount` that went to credit
 *     rather than to the voucher. Applied to fees = total_amount - excess_amount.
 *   - `from_credit`: the deposit brought in no new cash. Never count it as cash.
 */
export const FAMILY_CREDIT_METHOD = 'family_credit';

export const FAMILY_CREDIT_KIND = {
    EXCESS_DEPOSIT: 'EXCESS_DEPOSIT',
    APPLIED_TO_VOUCHER: 'APPLIED_TO_VOUCHER',
    EXCESS_REVERSED: 'EXCESS_REVERSED',
    APPLICATION_REVERSED: 'APPLICATION_REVERSED',
    // TAFSD-504: manual entries from the Family Credit tile. None of them is a
    // deposit or touches a voucher, so no cash or fee report ever sees them.
    MANUAL_CREDIT: 'MANUAL_CREDIT',
    MANUAL_DEBIT: 'MANUAL_DEBIT',
    REFUNDED: 'REFUNDED',
    TRANSFER_OUT: 'TRANSFER_OUT',
    TRANSFER_IN: 'TRANSFER_IN',
    ENTRY_REVERSED: 'ENTRY_REVERSED',
} as const;
export type FamilyCreditKind = (typeof FAMILY_CREDIT_KIND)[keyof typeof FAMILY_CREDIT_KIND];

/** Plain-language name of each kind, for exports and audit notes. */
export const FAMILY_CREDIT_KIND_LABEL: Record<FamilyCreditKind, string> = {
    EXCESS_DEPOSIT: 'Excess payment kept',
    APPLIED_TO_VOUCHER: 'Used on a voucher',
    EXCESS_REVERSED: 'Excess payment reversed',
    APPLICATION_REVERSED: 'Voucher payment reversed',
    MANUAL_CREDIT: 'Credit added',
    MANUAL_DEBIT: 'Credit deducted',
    REFUNDED: 'Refunded to family',
    TRANSFER_OUT: 'Moved to another family',
    TRANSFER_IN: 'Moved in from another family',
    ENTRY_REVERSED: 'Entry undone',
};

/**
 * TAFSD-504: the entries the Family Credit tile writes, and the only ones it can
 * undo. A deposit's entries are undone by reversing the deposit, never here, or
 * the deposit and the ledger would disagree.
 */
export const MANUAL_FAMILY_CREDIT_KINDS: readonly FamilyCreditKind[] = [
    FAMILY_CREDIT_KIND.MANUAL_CREDIT,
    FAMILY_CREDIT_KIND.MANUAL_DEBIT,
    FAMILY_CREDIT_KIND.REFUNDED,
    FAMILY_CREDIT_KIND.TRANSFER_OUT,
    FAMILY_CREDIT_KIND.TRANSFER_IN,
];

export const REFUND_METHODS = ['cash', 'cheque', 'bank_transfer'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

type Money = Prisma.Decimal | number | string;
const ZERO = new Prisma.Decimal(0);
const dec = (v: Money | null | undefined) => new Prisma.Decimal(v ?? 0);
export const rs = (v: Money) => `Rs. ${dec(v).toFixed(2)}`;

export function sumLedger(rows: Array<{ amount: Money }>): Prisma.Decimal {
    return rows.reduce((sum: Prisma.Decimal, r) => sum.add(dec(r.amount)), ZERO);
}

/** A voucher can only be paid from credit the family actually holds. */
export function assertCreditCovers(balance: Money, amount: Money): void {
    if (dec(amount).gt(dec(balance))) {
        throw new BadRequestException(
            `This family has ${rs(balance)} of credit, which does not cover ${rs(amount)}.`,
        );
    }
}

/** Credit lives on the family, so a student with no family record cannot use it. */
export function assertHasFamily(familyId: number | null | undefined): asserts familyId is number {
    if (familyId == null) {
        throw new BadRequestException(
            'This student is not linked to a family, so family credit cannot be used. Link the family first.',
        );
    }
}

/**
 * An excess is only what is left after the voucher is cleared. An overdue
 * voucher's late fee counts: a family that still owes it has no excess.
 */
export function assertExcessClearsVoucher(voucherStatus: string, overdueLateFeeOwed: Money): void {
    if (voucherStatus !== 'PAID' || dec(overdueLateFeeOwed).gt(0)) {
        throw new BadRequestException(
            'An excess can only be recorded when this deposit clears the whole voucher, including any late fee.',
        );
    }
}

/**
 * The opposite row that undoes a deposit's credit entries, or null if it has
 * none. Refuses to return credit that has already been spent: the deposit that
 * created it can't be reversed until the deposits that used it are.
 */
export function creditReversalEntry(
    netOnDeposit: Money,
    familyBalance: Money,
): { amount: Prisma.Decimal; kind: FamilyCreditKind } | null {
    const net = dec(netOnDeposit);
    if (net.eq(0)) return null;
    if (net.gt(0)) {
        if (net.gt(dec(familyBalance))) {
            throw new BadRequestException(
                `${rs(net)} of this deposit became family credit, but only ${rs(familyBalance)} is left because ` +
                    'the rest has been used on another voucher, refunded, deducted or moved to another family. ' +
                    'Reverse those deposits first, or undo those entries in Family Credit.',
            );
        }
        return { amount: net.negated(), kind: FAMILY_CREDIT_KIND.EXCESS_REVERSED };
    }
    return { amount: net.negated(), kind: FAMILY_CREDIT_KIND.APPLICATION_REVERSED };
}

/**
 * True when a student's deposits still have credit entries that haven't been
 * undone. Wiping those deposits would strand the family's ledger.
 */
export function hasOpenCreditEntries(rows: Array<{ deposit_id: number | null; amount: Money }>): boolean {
    const byDeposit = new Map<number, Prisma.Decimal>();
    for (const r of rows) {
        if (r.deposit_id == null) continue;
        byDeposit.set(r.deposit_id, (byDeposit.get(r.deposit_id) ?? ZERO).add(dec(r.amount)));
    }
    return [...byDeposit.values()].some((net) => !net.eq(0));
}

/**
 * Takes the row lock that makes the balance safe to act on. Two staff paying
 * from the same family's credit at once would otherwise both see enough.
 */
export async function lockFamilyCreditBalance(
    tx: Prisma.TransactionClient,
    familyId: number,
): Promise<Prisma.Decimal> {
    await tx.$queryRaw`SELECT id FROM families WHERE id = ${familyId} FOR UPDATE`;
    const agg = await tx.family_credit_ledger.aggregate({
        where: { family_id: familyId },
        _sum: { amount: true },
    });
    return dec(agg._sum.amount);
}

/**
 * TAFSD-504: a manual amount is positive, in rupees and paisa at most, and
 * sane. The ledger column is Decimal(12, 2).
 */
export function assertManualAmount(amount: Money): Prisma.Decimal {
    const d = dec(amount);
    if (!d.isFinite() || d.lte(0)) throw new BadRequestException('Enter an amount above zero.');
    if (d.decimalPlaces() > 2) throw new BadRequestException('The amount can have at most two decimal places.');
    if (d.gt(100_000_000)) throw new BadRequestException('That amount is too large for a single entry.');
    return d;
}

/** Every manual entry carries a reason, so the ledger explains itself. */
export function assertReason(reason: string | null | undefined): string {
    const r = (reason ?? '').trim();
    if (r.length < 3) throw new BadRequestException('Give a reason of at least a few words.');
    if (r.length > 500) throw new BadRequestException('Keep the reason under 500 characters.');
    return r;
}

/** Taking credit out never leaves a family below zero. */
export function assertBalanceCovers(balance: Money, amount: Money, familyLabel = 'This family'): void {
    if (dec(amount).gt(dec(balance))) {
        throw new BadRequestException(
            `${familyLabel} has ${rs(balance)} of credit, so ${rs(amount)} can't be taken out. The balance can't go below zero.`,
        );
    }
}

type LedgerRowLike = {
    id: number;
    family_id: number;
    amount: Money;
    kind: string;
    linked_entry_id?: number | null;
};

/**
 * TAFSD-504: which rows an Undo of `entry` must cancel. A transfer is undone as a
 * pair, from either side, so money never ends up in only one of the two families.
 * Refuses anything that is not a manual entry.
 */
export function rowsToUndo<T extends LedgerRowLike>(entry: T, pair: T | null): T[] {
    if (!MANUAL_FAMILY_CREDIT_KINDS.includes(entry.kind as FamilyCreditKind)) {
        if (entry.kind === FAMILY_CREDIT_KIND.ENTRY_REVERSED) {
            throw new BadRequestException('This entry is itself an undo. Add a new entry instead.');
        }
        throw new BadRequestException(
            "This entry came from a deposit. Reverse the deposit on Receive Deposit or Payment History instead, so the deposit and the credit stay in step.",
        );
    }
    const isTransfer = entry.kind === FAMILY_CREDIT_KIND.TRANSFER_OUT || entry.kind === FAMILY_CREDIT_KIND.TRANSFER_IN;
    if (!isTransfer) return [entry];
    if (!pair) throw new BadRequestException('The other half of this transfer is missing, so it cannot be undone here.');
    const out = entry.kind === FAMILY_CREDIT_KIND.TRANSFER_OUT ? entry : pair;
    const into = entry.kind === FAMILY_CREDIT_KIND.TRANSFER_IN ? entry : pair;
    if (out.kind !== FAMILY_CREDIT_KIND.TRANSFER_OUT || into.kind !== FAMILY_CREDIT_KIND.TRANSFER_IN || into.linked_entry_id !== out.id) {
        throw new BadRequestException('The other half of this transfer does not match, so it cannot be undone here.');
    }
    return [out, into];
}

/**
 * The opposite rows for an undo, checked against each family's balance (taken
 * under lock). Undoing an added credit, or the receiving side of a transfer,
 * takes money out, so the family must still hold it.
 */
export function undoEntries<T extends LedgerRowLike>(
    rows: T[],
    balances: Map<number, Money>,
): Array<{ family_id: number; amount: Prisma.Decimal; reverses_entry_id: number }> {
    const after = new Map<number, Prisma.Decimal>();
    for (const [id, b] of balances) after.set(id, dec(b));
    const out = rows.map((r) => {
        const amount = dec(r.amount).negated();
        const next = (after.get(r.family_id) ?? ZERO).add(amount);
        if (next.lt(0)) {
            throw new BadRequestException(
                `Undoing this would leave family #${r.family_id} below zero: it holds ` +
                    `${rs(after.get(r.family_id) ?? ZERO)} and the undo takes ${rs(amount.abs())}. ` +
                    'Some of that credit has already been used.',
            );
        }
        after.set(r.family_id, next);
        return { family_id: r.family_id, amount, reverses_entry_id: r.id };
    });
    return out;
}

/** Lock several families in a fixed order, so two transfers can't deadlock. */
export async function lockFamilyCreditBalances(
    tx: Prisma.TransactionClient,
    familyIds: number[],
): Promise<Map<number, Prisma.Decimal>> {
    const ids = [...new Set(familyIds)].sort((a, b) => a - b);
    const balances = new Map<number, Prisma.Decimal>();
    for (const id of ids) balances.set(id, await lockFamilyCreditBalance(tx, id));
    return balances;
}
