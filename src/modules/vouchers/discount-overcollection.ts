import { Prisma } from '@prisma/client';

/**
 * TAFSD-581: a deposit must not pay a discounted voucher in full cash.
 *
 * A discount is a separate `student_fees` row on the voucher. It is spent only
 * by `applyDiscountCreditInTx`, which closes heads the cash left short. So if
 * the cash entered covers every head at its full amount, there is nothing left
 * for the discount to close: it stays unused and the family is recorded as
 * paying the discount on top of the bill the challan gave them.
 *
 * That is how voucher 14176 (CC 7165) was booked. The challan said Rs 233,943
 * after due (Rs 272,599 of fees less a Rs 39,656 discount, plus the Rs 1,000
 * late fee). The deposit page asked for, and recorded, Rs 273,599. Eleven
 * other vouchers carrying a "full year advance" discount were booked the
 * same way.
 *
 * Returns how much the deposit over-collects: the discount still unused once
 * the deposit and its discount credit are in, capped at the cash it put on
 * heads. Zero when the voucher has no discount, when some head is still short
 * (the discount can still close it later), or when the deposit put no cash on
 * heads (a late-fee-only or surcharge-only payment).
 */
export function discountLeftUnusedByCash(input: {
    /** Sum of the voucher's discount rows' `amount`. */
    discountCapacity: Prisma.Decimal.Value;
    /** Discount already spent: the voucher's DISCOUNT allocations, this deposit's included. */
    discountConsumed: Prisma.Decimal.Value;
    /** What every non-discount, non-waived head still owes after this deposit. */
    headsStillShort: Prisma.Decimal.Value;
    /** Cash this deposit put on fee heads. */
    cashToHeads: Prisma.Decimal.Value;
}): Prisma.Decimal {
    const zero = new Prisma.Decimal(0);
    const unused = Prisma.Decimal.max(
        new Prisma.Decimal(input.discountCapacity).sub(new Prisma.Decimal(input.discountConsumed)),
        zero,
    );
    const cash = new Prisma.Decimal(input.cashToHeads);
    if (unused.lte(0) || cash.lte(0)) return zero;
    if (new Prisma.Decimal(input.headsStillShort).gt(0)) return zero;
    return Prisma.Decimal.min(unused, cash);
}
