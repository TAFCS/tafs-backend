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
} as const;
export type FamilyCreditKind = (typeof FAMILY_CREDIT_KIND)[keyof typeof FAMILY_CREDIT_KIND];

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
                    'the rest has been used on another voucher. Reverse those deposits first.',
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
