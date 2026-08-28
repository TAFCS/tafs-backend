/**
 * One-off backfill: corrects deposits.total_amount for vouchers that carried a
 * discount head but were recorded (BEFORE the discount-aware deposit fix — see
 * VouchersService.applyDiscountCreditInTx) as if the family had paid the full
 * GROSS amount. Confirmed with the school: the family actually paid the NET
 * (discounted) amount — deposits.total_amount was simply recorded wrong at the
 * time, at the gross figure. This corrects that record. It is a real change to
 * "how much cash was collected," not a pure reclassification — the Deposits
 * report's "Cash banked" total and each corrected deposit's own amount WILL
 * drop as a result, by design, because that's what actually happened.
 *
 * Confirmed by scripts/audit-discount-deposits.ts against the live data before
 * this was written: every affected voucher has this exact shape —
 *   recorded_cash (sum of FEE_HEAD allocations across real heads) == gross_owed
 *   (sum of student_fees.amount across real heads), and
 *   recorded_cash - (gross_owed - discount_cap) == discount_cap  (to the cent).
 * i.e. the deposit was recorded as covering the full GROSS total with nothing
 * left over and nothing missing — a clean "discount was never subtracted at
 * recording time" signature, not a partial payment or an unrelated
 * overpayment. Only vouchers matching that exact signature are touched;
 * anything messier is skipped and printed for manual review instead of
 * guessed at.
 *
 * What gets written, per matching voucher, inside one transaction:
 *   1. Walk its real (non-discount) heads in DESCENDING id order (last-billed
 *      head absorbs the discount first — mirrors how a concession reads most
 *      naturally at settlement, and how the live bug's own auto-fill always
 *      left the LAST head short). For each head's existing FEE_HEAD
 *      deposit_allocations rows (most-recent deposit first, for a voucher paid
 *      across more than one deposit), reduce the allocation by up to what's
 *      left of the discount capacity — deleting the row if fully consumed,
 *      decrementing it otherwise — and write a same-size 'DISCOUNT' allocation
 *      in its place (same deposit_id, same student_fee_id). This records that
 *      the head's total-paid still comes from cash + discount, exactly as it
 *      always did — only how much of it was CASH changes.
 *   2. Decrement deposits.total_amount, per deposit touched, by exactly what
 *      was reclassified off it — deposits.total_amount now equals the sum of
 *      its remaining FEE_HEAD/LATE_FEE/SURCHARGE allocations, matching what
 *      the Deposits report's cash-vs-allocations reconciliation expects.
 *   3. Sync the discount head's own student_fees.amount_paid to reflect it's
 *      now fully consumed (same derivation as
 *      VouchersService.syncDiscountHeadsAmountPaidInTx).
 *   4. One audit_logs entry per voucher explaining the correction.
 * Deliberately NOT touched: any real head's own student_fees.amount_paid/
 * status or voucher_heads.balance (unchanged — the total consumed on each
 * real head is identical before and after; only how much of it was cash vs.
 * discount changes), and vouchers.status.
 *
 * Idempotent: a voucher already carrying any 'DISCOUNT' allocation is skipped,
 * so a repeat run is a no-op for anything already corrected.
 *
 * SAFETY: unlike this repo's other backfill scripts (which default to LIVE),
 * this one defaults to preview-only given the financial data and multi-family
 * scope — pass --apply to actually write.
 *
 * Usage:
 *   npx ts-node scripts/backfill-discount-deposits.ts                        # preview all
 *   npx ts-node scripts/backfill-discount-deposits.ts --apply                # write all
 *   npx ts-node scripts/backfill-discount-deposits.ts --voucher=10200 --apply  # one voucher only
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const CENT = new Prisma.Decimal(0.01);
const ONLY_VOUCHER_ID = (() => {
    const arg = process.argv.find((a) => a.startsWith('--voucher='));
    return arg ? Number(arg.split('=')[1]) : null;
})();

async function main() {
    console.log(`\n=== Discount deposit-amount backfill ${APPLY ? '(APPLY — will write)' : '(PREVIEW ONLY — pass --apply to write)'} ===\n`);

    const discountHeads = await prisma.voucher_heads.findMany({
        where: { student_fees: { is_discount: true } },
        select: { voucher_id: true, student_fee_id: true, student_fees: { select: { id: true, amount: true } } },
    });
    const voucherIds = Array.from(new Set(discountHeads.map((h) => h.voucher_id)));

    const vouchers = await prisma.vouchers.findMany({
        where: {
            id: ONLY_VOUCHER_ID ? ONLY_VOUCHER_ID : { in: voucherIds },
            status: { not: 'VOID' },
        },
        select: {
            id: true,
            voucher_number: true,
            student_id: true,
            status: true,
            voucher_heads: {
                select: {
                    id: true,
                    student_fee_id: true,
                    student_fees: { select: { id: true, is_discount: true, amount: true, amount_paid: true } },
                },
            },
        },
    });

    let touched = 0;
    let skippedAlready = 0;
    let skippedNotCleanSignature = 0;
    let totalCorrected = new Prisma.Decimal(0);

    for (const v of vouchers) {
        const existingDiscountAlloc = await prisma.deposit_allocations.findFirst({
            where: { voucher_id: v.id, type: 'DISCOUNT' },
        });
        if (existingDiscountAlloc) {
            skippedAlready++;
            continue;
        }

        const discountFees = v.voucher_heads
            .filter((h) => h.student_fees?.is_discount)
            .map((h) => h.student_fees!)
            .sort((a, b) => a.id - b.id);
        if (discountFees.length === 0) continue;

        const discountCap = discountFees.reduce(
            (s, f) => s.add(new Prisma.Decimal(f.amount ?? 0)),
            new Prisma.Decimal(0),
        );
        if (discountCap.lte(0)) continue;

        const realHeads = v.voucher_heads.filter((h) => !h.student_fees?.is_discount);
        const grossOwed = realHeads.reduce(
            (s, h) => s.add(new Prisma.Decimal(h.student_fees?.amount ?? 0)),
            new Prisma.Decimal(0),
        );

        // Scoped by voucher_id, NOT just student_fee_id — a student_fee can be
        // shared by more than one voucher_heads row across different vouchers
        // (a duplicate/superseded voucher that was never actually voided;
        // confirmed live: #5339 and #5349 share all 13 underlying student_fees,
        // but only #5339 has real cash). Matching by fee id alone would let a
        // sibling voucher's allocations be reduced/reclassified for THIS
        // voucher's discount, corrupting both.
        const feeIds = realHeads.map((h) => h.student_fee_id);
        const allocs = feeIds.length
            ? await prisma.deposit_allocations.findMany({
                where: { voucher_id: v.id, student_fee_id: { in: feeIds }, type: 'FEE_HEAD' },
                include: { deposits: { select: { deposit_date: true, total_amount: true } } },
            })
            : [];
        const recordedCash = allocs.reduce((s, a) => s.add(new Prisma.Decimal(a.amount)), new Prisma.Decimal(0));

        const netTarget = grossOwed.sub(discountCap);
        const over = recordedCash.sub(netTarget);

        // Only the exact "gross-vs-net" signature — recorded cash covers gross
        // precisely, and the overage is precisely the discount capacity.
        // Anything else (partial payment, an unrelated overpayment, a
        // partially-applied discount) is left alone for a human to look at
        // individually.
        const isCleanSignature = recordedCash.sub(grossOwed).abs().lte(CENT) && over.sub(discountCap).abs().lte(CENT);
        if (!isCleanSignature) {
            if (over.gt(CENT)) {
                console.log(`  SKIP voucher #${v.id}: overage Rs.${over.toFixed(2)} does not cleanly match discount cap Rs.${discountCap.toFixed(2)} — needs manual review.`);
                skippedNotCleanSignature++;
            }
            continue;
        }

        // Reclassification targets: real heads, last-billed first; within a head,
        // its most-recent deposit's allocation first.
        const orderedHeads = [...realHeads].sort((a, b) => b.id - a.id);
        const allocsByHead = new Map<number, typeof allocs>();
        for (const a of allocs) {
            if (a.student_fee_id == null) continue;
            const arr = allocsByHead.get(a.student_fee_id) ?? [];
            arr.push(a);
            allocsByHead.set(a.student_fee_id, arr);
        }
        for (const arr of allocsByHead.values()) {
            arr.sort((a, b) => (b.deposits?.deposit_date?.getTime() ?? 0) - (a.deposits?.deposit_date?.getTime() ?? 0));
        }

        const plan: { allocationId: number; depositId: number; feeId: number; headId: number; reduceBy: Prisma.Decimal; fullyConsumed: boolean }[] = [];
        let remaining = discountCap;
        for (const head of orderedHeads) {
            if (remaining.lte(0)) break;
            const headAllocs = allocsByHead.get(head.student_fee_id) ?? [];
            for (const a of headAllocs) {
                if (remaining.lte(0)) break;
                const available = new Prisma.Decimal(a.amount);
                const reduceBy = Prisma.Decimal.min(remaining, available);
                if (reduceBy.lte(0)) continue;
                plan.push({
                    allocationId: a.id, depositId: a.deposit_id, feeId: head.student_fee_id,
                    headId: head.id, reduceBy, fullyConsumed: reduceBy.eq(available),
                });
                remaining = remaining.sub(reduceBy);
            }
        }

        if (remaining.gt(CENT)) {
            console.log(`  SKIP voucher #${v.id}: only found Rs.${discountCap.sub(remaining).toFixed(2)} of Rs.${discountCap.toFixed(2)} in reclassifiable FEE_HEAD cash — needs manual review.`);
            skippedNotCleanSignature++;
            continue;
        }

        // How much deposits.total_amount needs to drop, per deposit touched
        // (almost always one deposit; #6233 in the live data spans two).
        const depositReductions = new Map<number, Prisma.Decimal>();
        for (const p of plan) {
            depositReductions.set(p.depositId, (depositReductions.get(p.depositId) ?? new Prisma.Decimal(0)).add(p.reduceBy));
        }

        touched++;
        totalCorrected = totalCorrected.add(discountCap);
        console.log(`  Voucher #${v.id} (${v.voucher_number ?? 'no-number'}) student #${v.student_id} [${v.status}]: correcting Rs.${discountCap.toFixed(2)} across ${plan.length} allocation(s):`);
        for (const p of plan) {
            console.log(`    head #${p.headId} / fee #${p.feeId} / deposit #${p.depositId}: -Rs.${p.reduceBy.toFixed(2)} FEE_HEAD ${p.fullyConsumed ? '(row deleted)' : '(decremented)'} -> +Rs.${p.reduceBy.toFixed(2)} DISCOUNT`);
        }
        for (const [depositId, amount] of depositReductions) {
            const before = allocs.find((a) => a.deposit_id === depositId)?.deposits?.total_amount;
            const beforeDec = new Prisma.Decimal(before ?? 0);
            console.log(`    deposit #${depositId}: total_amount ${beforeDec.toFixed(2)} -> ${beforeDec.sub(amount).toFixed(2)}`);
        }

        if (!APPLY) continue;

        await prisma.$transaction(async (tx) => {
            for (const p of plan) {
                if (p.fullyConsumed) {
                    await tx.deposit_allocations.delete({ where: { id: p.allocationId } });
                } else {
                    await tx.deposit_allocations.update({
                        where: { id: p.allocationId },
                        data: { amount: { decrement: p.reduceBy } },
                    });
                }
                await tx.deposit_allocations.create({
                    data: {
                        deposit_id: p.depositId,
                        voucher_id: v.id,
                        student_fee_id: p.feeId,
                        amount: p.reduceBy,
                        type: 'DISCOUNT',
                    },
                });
            }

            for (const [depositId, amount] of depositReductions) {
                await tx.deposits.update({
                    where: { id: depositId },
                    data: { total_amount: { decrement: amount } },
                });
            }

            // Sync the discount head(s)' own amount_paid — same derivation as
            // VouchersService.syncDiscountHeadsAmountPaidInTx.
            let toDistribute = discountCap;
            for (const fee of discountFees) {
                const capacity = new Prisma.Decimal(fee.amount ?? 0);
                const applied = Prisma.Decimal.min(toDistribute, capacity);
                toDistribute = toDistribute.sub(applied);
                await tx.student_fees.update({ where: { id: fee.id }, data: { amount_paid: applied } });
            }

            await tx.audit_logs.create({
                data: {
                    entity_type: 'DEPOSIT',
                    entity_id: String(plan[0].depositId),
                    action: 'UPDATED',
                    field: 'total_amount',
                    changed_by: 'backfill-discount-deposits',
                    student_id: v.student_id,
                    note: `Historical correction: voucher #${v.id}'s discount was never subtracted when its deposit(s) were recorded, so deposits.total_amount was overstated by Rs. ${discountCap.toFixed(2)} (the family actually paid the net/discounted amount). Corrected deposits.total_amount down by that amount and re-classified the matching FEE_HEAD cash allocation as DISCOUNT. Run via scripts/backfill-discount-deposits.ts.`,
                } as any,
            });
        }, { timeout: 30000 }); // this script's DB round-trip latency is higher than the
        // deployed backend's — the 5s interactive-transaction default tripped mid-run
        // against live data (see regenerate-payroll-runs.ts for the same fix).
    }

    console.log(`\n--- Summary ---`);
    console.log(`Vouchers corrected${APPLY ? '' : ' (would be, preview only)'}: ${touched}`);
    console.log(`Total deposits.total_amount reduction: Rs. ${totalCorrected.toFixed(2)}`);
    console.log(`Already corrected (idempotent skip): ${skippedAlready}`);
    console.log(`Skipped — not a clean signature, needs manual review: ${skippedNotCleanSignature}`);
    if (!APPLY && touched > 0) {
        console.log(`\nRe-run with --apply to write these changes.`);
    }

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
});
