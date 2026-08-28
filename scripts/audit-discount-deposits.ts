/**
 * READ-ONLY AUDIT: finds vouchers that carry a discount head where past deposit
 * activity predates the discount-aware deposit fix (see
 * VouchersService.applyDiscountCreditInTx / recordDeposit).
 *
 * Before that fix, no 'DISCOUNT' deposit_allocations row could ever exist, so a
 * voucher's discount capacity was never actually applied against real cash
 * collected. This script does NOT write anything — it only categorizes every
 * affected voucher so a human can decide what (if anything) should be backfilled.
 *
 * For each voucher carrying >=1 discount head, per real (non-discount) head:
 *   headGross         = student_fees.amount
 *   headCashPaid       = SUM(deposit_allocations.amount WHERE student_fee_id=head's
 *                        fee AND type IN ('FEE_HEAD')) — before this fix, that's the
 *                        entire history of amount_paid on a real head; no other
 *                        allocation type ever touched one.
 * Rolled up per voucher:
 *   grossOwed   = sum of headGross across real heads
 *   cashPaid    = sum of headCashPaid across real heads
 *   discountCap = sum of discount heads' `amount` on the voucher
 *   gap         = grossOwed - cashPaid   (what the old system still thinks is owed)
 *
 * Categories:
 *   EXACT_MATCH   gap > 0 AND cashPaid == grossOwed - discountCap (to the cent).
 *                 The family paid precisely the discounted total — unambiguous,
 *                 the only category this script suggests is safe to backfill.
 *   WITHIN_CAP    gap > 0 AND gap <= discountCap, but not an exact match. Could be
 *                 a genuine partial payment still in progress that happens to be
 *                 smaller than the discount — needs a human to look at the specific
 *                 deposit history, NOT auto-fixed.
 *   OVER_CAP      gap > discountCap. The discount alone can't explain the shortfall
 *                 — either the family is still paying, or something else is wrong.
 *                 Not a discount-fix candidate.
 *   OVERCOLLECTED cashPaid > grossOwed - discountCap by more than a cent — i.e. the
 *                 family was charged/paid MORE than the discounted total (likely the
 *                 original bug: staff collected the gross amount, discount ignored).
 *                 This is real extra cash sitting on the books, not a data-entry
 *                 fix — flagged for manual finance review (refund / credit note),
 *                 never auto-corrected here.
 *   DISCOUNT_AS_CASH  a deposit_allocations row exists whose student_fee_id IS the
 *                 discount head's own id (the Meezan-loop bug: the discount's own
 *                 positive amount got auto-collected as if it were a real fee).
 *                 Flagged separately — needs the same manual review as OVERCOLLECTED.
 *   NO_DEPOSITS   discountCap > 0 but no cash has been recorded at all yet — nothing
 *                 to backfill; the live fix already handles this voucher correctly
 *                 going forward.
 *
 * Usage:
 *   npx ts-node scripts/audit-discount-deposits.ts
 *   npx ts-node scripts/audit-discount-deposits.ts --csv > discount-audit.csv
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CSV = process.argv.includes('--csv');
const CENT = 0.01;

async function main() {
    if (!CSV) console.log('\n=== Discount-aware deposit backfill audit (READ ONLY) ===\n');

    // Every voucher that has at least one discount head attached.
    const discountHeads = await prisma.voucher_heads.findMany({
        where: { student_fees: { is_discount: true } },
        select: {
            voucher_id: true,
            student_fee_id: true,
            student_fees: { select: { id: true, amount: true, amount_paid: true } },
        },
    });

    const voucherIds = Array.from(new Set(discountHeads.map((h) => h.voucher_id)));
    if (!CSV) console.log(`Vouchers with a discount head attached: ${voucherIds.length}\n`);

    const discountCapByVoucher = new Map<number, number>();
    const discountFeeIdsByVoucher = new Map<number, number[]>();
    for (const h of discountHeads) {
        discountCapByVoucher.set(
            h.voucher_id,
            (discountCapByVoucher.get(h.voucher_id) ?? 0) + Number(h.student_fees?.amount ?? 0),
        );
        const arr = discountFeeIdsByVoucher.get(h.voucher_id) ?? [];
        arr.push(h.student_fee_id);
        discountFeeIdsByVoucher.set(h.voucher_id, arr);
    }

    const vouchers = await prisma.vouchers.findMany({
        where: { id: { in: voucherIds } },
        select: {
            id: true,
            status: true,
            student_id: true,
            voucher_number: true,
            voucher_heads: {
                select: {
                    student_fee_id: true,
                    student_fees: { select: { id: true, is_discount: true, amount: true } },
                },
            },
        },
    });

    // All FEE_HEAD allocations against any head on any of these vouchers, in one
    // query — grouped by (voucher_id, student_fee_id), NOT student_fee_id alone.
    // A student_fee can be shared by more than one voucher_heads row across
    // different vouchers (e.g. a duplicate/superseded voucher that was never
    // actually voided — confirmed against live data: vouchers #5339 and #5349
    // share all 13 underlying student_fees, but only #5339 has real cash; #5349
    // has none of its own). Grouping by student_fee_id alone would attribute
    // #5339's cash to #5349 too and misclassify a voucher that collected nothing.
    const feeHeadAllocs = await prisma.deposit_allocations.groupBy({
        by: ['voucher_id', 'student_fee_id'],
        where: { voucher_id: { in: voucherIds }, type: 'FEE_HEAD' },
        _sum: { amount: true },
    });
    const cashPaidByVoucherFee = new Map<string, number>(
        feeHeadAllocs.map((r) => [`${r.voucher_id}:${r.student_fee_id}`, Number(r._sum.amount ?? 0)]),
    );

    // The Meezan-loop bug: a FEE_HEAD allocation whose student_fee_id is itself a
    // discount row's id.
    const allDiscountFeeIds = Array.from(discountFeeIdsByVoucher.values()).flat();
    const discountAsCashAllocs = await prisma.deposit_allocations.findMany({
        where: { student_fee_id: { in: allDiscountFeeIds }, type: 'FEE_HEAD' },
        select: { student_fee_id: true, amount: true, voucher_id: true, deposit_id: true },
    });
    const discountAsCashByVoucher = new Set(discountAsCashAllocs.map((a) => a.voucher_id));

    const counts: Record<string, number> = {
        EXACT_MATCH: 0, WITHIN_CAP: 0, OVER_CAP: 0, OVERCOLLECTED: 0,
        DISCOUNT_AS_CASH: 0, NO_DEPOSITS: 0, VOID_SKIPPED: 0, PAID_ALREADY: 0,
    };
    let exactMatchTotal = 0;
    let overcollectedTotal = 0;
    const exactMatchRows: any[] = [];
    const needsReviewRows: any[] = [];

    if (CSV) {
        console.log('voucher_id,voucher_number,student_id,status,category,gross_owed,cash_paid,discount_cap,gap');
    }

    for (const v of vouchers) {
        if (discountAsCashByVoucher.has(v.id)) {
            counts.DISCOUNT_AS_CASH++;
            const rows = discountAsCashAllocs.filter((a) => a.voucher_id === v.id);
            needsReviewRows.push({
                voucher_id: v.id, category: 'DISCOUNT_AS_CASH',
                detail: rows.map((r) => `fee#${r.student_fee_id} Rs.${r.amount} (deposit#${r.deposit_id})`).join('; '),
            });
        }

        const realHeads = v.voucher_heads.filter((h) => !h.student_fees?.is_discount);
        const grossOwed = realHeads.reduce((s, h) => s + Number(h.student_fees?.amount ?? 0), 0);
        const cashPaid = realHeads.reduce(
            (s, h) => s + (cashPaidByVoucherFee.get(`${v.id}:${h.student_fee_id}`) ?? 0),
            0,
        );
        const discountCap = discountCapByVoucher.get(v.id) ?? 0;
        const gap = grossOwed - cashPaid;
        const netTarget = grossOwed - discountCap;

        // Checked BEFORE any "already PAID, nothing to see here" shortcut — a
        // voucher reaches PAID by collecting cash >= grossOwed on every real head,
        // which is exactly what happens if staff (correctly, from their point of
        // view, pre-fix) collected the full gross amount instead of the discounted
        // one. A PAID status alone says nothing about whether that cash was right.
        let category: string;
        if (v.status === 'VOID') {
            category = 'VOID_SKIPPED';
        } else if (cashPaid === 0 && gap === grossOwed) {
            category = 'NO_DEPOSITS';
        } else if (cashPaid - netTarget > CENT) {
            category = 'OVERCOLLECTED';
            overcollectedTotal += cashPaid - netTarget;
            needsReviewRows.push({
                voucher_id: v.id, category: 'OVERCOLLECTED',
                detail: `[${v.status}] paid Rs.${cashPaid} vs net-of-discount Rs.${netTarget} (over by Rs.${(cashPaid - netTarget).toFixed(2)})`,
            });
        } else if (gap <= CENT) {
            category = v.status === 'PAID' ? 'PAID_CORRECT' : 'GAP_ALREADY_ZERO';
        } else if (Math.abs(cashPaid - netTarget) <= CENT) {
            category = 'EXACT_MATCH';
            exactMatchTotal += Math.min(gap, discountCap);
            exactMatchRows.push({
                voucher_id: v.id, voucher_number: v.voucher_number, student_id: v.student_id,
                status: v.status, gross_owed: grossOwed, cash_paid: cashPaid,
                discount_cap: discountCap, gap,
            });
        } else if (gap > 0 && gap <= discountCap + CENT) {
            category = 'WITHIN_CAP';
            needsReviewRows.push({
                voucher_id: v.id, category: 'WITHIN_CAP',
                detail: `[${v.status}] gap Rs.${gap} vs discount cap Rs.${discountCap}, cash paid Rs.${cashPaid} of gross Rs.${grossOwed}`,
            });
        } else {
            category = 'OVER_CAP';
        }

        counts[category] = (counts[category] ?? 0) + 1;

        if (CSV) {
            console.log([v.id, v.voucher_number ?? '', v.student_id, v.status, category, grossOwed, cashPaid, discountCap, gap].join(','));
        }
    }

    if (!CSV) {
        console.log('Category breakdown:');
        for (const [k, v] of Object.entries(counts)) {
            console.log(`  ${k.padEnd(18)} ${v}`);
        }
        console.log(`\nEXACT_MATCH total discount-credit that would be backfilled: Rs. ${exactMatchTotal.toFixed(2)}`);
        console.log(`OVERCOLLECTED total extra cash sitting on the books (needs finance review): Rs. ${overcollectedTotal.toFixed(2)}\n`);

        if (exactMatchRows.length > 0) {
            console.log(`--- EXACT_MATCH candidates (safe to backfill, first 25 of ${exactMatchRows.length}) ---`);
            for (const r of exactMatchRows.slice(0, 25)) {
                console.log(`  voucher #${r.voucher_id} (${r.voucher_number ?? 'no-number'}) student #${r.student_id} [${r.status}]: gross ${r.gross_owed} - cash ${r.cash_paid} = gap ${r.gap.toFixed(2)}, discount cap ${r.discount_cap}`);
            }
            console.log();
        }

        if (needsReviewRows.length > 0) {
            console.log(`--- Needs manual review (first 25 of ${needsReviewRows.length}) ---`);
            for (const r of needsReviewRows.slice(0, 25)) {
                console.log(`  voucher #${r.voucher_id} [${r.category}]: ${r.detail}`);
            }
            console.log();
        }
    }

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
});
