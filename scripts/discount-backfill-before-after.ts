/**
 * READ-ONLY: prints a before/after CSV of what scripts/backfill-discount-deposits.ts
 * would change, per voucher.
 *
 * Columns, in the terms the question was actually asked in:
 *   voucher_stated_amount   — what the voucher itself said was payable
 *                             (total_payable_before_due, already net of the
 *                             discount at voucher-creation time — the number
 *                             printed on the challan).
 *   arrear_surcharge_collected — collected separately from the discount bug;
 *                             shown so it doesn't get mistaken for part of the
 *                             gap explained below.
 *   deposit_amount_before   — deposits.total_amount as currently recorded —
 *                             what the software says was actually collected.
 *   deposit_amount_after    — deposit_amount_before minus the discount amount.
 *                             The family actually paid the net amount — the
 *                             deposit was simply recorded at the gross figure
 *                             by mistake, so the backfill genuinely corrects
 *                             deposits.total_amount down to this figure (it is
 *                             NOT a pure reclassification with the total held
 *                             fixed — see scripts/backfill-discount-deposits.ts).
 *   discount_amount         — the voucher's attached discount capacity.
 *   gap_explained_by_discount — (deposit_amount_before - voucher_stated_amount
 *                             - arrear_surcharge_collected) - discount_amount.
 *                             Should be 0.00 on every row: proof the entire
 *                             difference between what the voucher said and
 *                             what's recorded as collected is fully accounted
 *                             for by the discount, with nothing left unexplained.
 *
 * Usage: npx ts-node scripts/discount-backfill-before-after.ts > before-after.csv
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const discountHeads = await prisma.voucher_heads.findMany({
        where: { student_fees: { is_discount: true } },
        select: { voucher_id: true, student_fees: { select: { amount: true } } },
    });
    const voucherIds = Array.from(new Set(discountHeads.map((h) => h.voucher_id)));
    const discountCapByVoucher = new Map<number, Prisma.Decimal>();
    for (const h of discountHeads) {
        const prev = discountCapByVoucher.get(h.voucher_id) ?? new Prisma.Decimal(0);
        discountCapByVoucher.set(h.voucher_id, prev.add(new Prisma.Decimal(h.student_fees?.amount ?? 0)));
    }

    const vouchers = await prisma.vouchers.findMany({
        where: { id: { in: voucherIds }, status: { not: 'VOID' } },
        select: { id: true, voucher_number: true, student_id: true, status: true, total_payable_before_due: true },
    });

    console.log([
        'voucher_id', 'voucher_number', 'student_id', 'status', 'deposit_ids',
        'voucher_stated_amount', 'arrear_surcharge_collected',
        'deposit_amount_before', 'deposit_amount_after',
        'discount_amount', 'gap_explained_by_discount',
    ].join(','));

    for (const v of vouchers) {
        const discountCap = discountCapByVoucher.get(v.id) ?? new Prisma.Decimal(0);
        if (discountCap.lte(0)) continue;

        // Scoped by voucher_id, not just student_fee_id — a fee can be shared
        // across more than one voucher (e.g. a duplicate that was never
        // actually voided); matching by fee id alone would double-count.
        const allocs = await prisma.deposit_allocations.findMany({
            where: { voucher_id: v.id },
            select: { deposit_id: true, amount: true, type: true },
        });
        const feeHeadCash = allocs
            .filter((a) => a.type === 'FEE_HEAD')
            .reduce((s, a) => s.add(new Prisma.Decimal(a.amount)), new Prisma.Decimal(0));
        const discountCash = allocs
            .filter((a) => a.type === 'DISCOUNT')
            .reduce((s, a) => s.add(new Prisma.Decimal(a.amount)), new Prisma.Decimal(0));
        const surchargeCash = allocs
            .filter((a) => a.type === 'SURCHARGE' || a.type === 'LATE_FEE')
            .reduce((s, a) => s.add(new Prisma.Decimal(a.amount)), new Prisma.Decimal(0));

        if (feeHeadCash.eq(0) && discountCash.eq(0)) continue; // no deposits yet, nothing to compare

        const depositIds = Array.from(new Set(allocs.map((a) => a.deposit_id)));
        const deposits = await prisma.deposits.findMany({
            where: { id: { in: depositIds } },
            select: { total_amount: true },
        });
        const depositTotal = deposits.reduce((s, d) => s.add(new Prisma.Decimal(d.total_amount)), new Prisma.Decimal(0));

        const voucherStated = new Prisma.Decimal(v.total_payable_before_due ?? 0);
        // The backfill genuinely reduces deposits.total_amount by the discount
        // — the family paid the net amount; the gross figure was a recording
        // error, not real extra cash.
        const depositAfter = depositTotal.sub(discountCap);
        const gapExplained = depositTotal.sub(voucherStated).sub(surchargeCash).sub(discountCap);

        console.log([
            v.id, v.voucher_number ?? '', v.student_id, v.status,
            `"${depositIds.join(';')}"`,
            voucherStated.toFixed(2), surchargeCash.toFixed(2),
            depositTotal.toFixed(2), depositAfter.toFixed(2),
            discountCap.toFixed(2), gapExplained.toFixed(2),
        ].join(','));
    }

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
});
