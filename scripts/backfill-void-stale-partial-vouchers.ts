/**
 * BACKFILL: void 9 stale PARTIALLY_PAID vouchers.
 *
 * These 9 students each have exactly one "active" voucher — a PARTIALLY_PAID one
 * that is NOT their most recent voucher. Manual review (see
 * scripts/inspect-student-voucher-timeline.ts) confirmed that for every one of
 * them a LATER voucher exists, that later voucher is PAID, and its amount
 * reconciles with the stale voucher's outstanding balance (or the stale voucher
 * is already fully/over-paid but stuck at PARTIALLY_PAID).
 *
 * This script ONLY flips `vouchers.status` -> 'VOID' and writes an audit_logs
 * row. It does NOT touch deposit_allocations, voucher_heads or student_fees — the
 * cash already received stays recorded against the (now VOID) voucher, and the
 * balance is already carried + paid on the later voucher.
 *
 * Safety: each target is pinned by (cc, voucher_id). A target is skipped (not
 * failed) unless it is currently PARTIALLY_PAID, belongs to that cc, AND the
 * student has a strictly-later PAID voucher.
 *
 * Usage:
 *   npx ts-node scripts/backfill-void-stale-partial-vouchers.ts            # dry run
 *   npx ts-node scripts/backfill-void-stale-partial-vouchers.ts --commit   # apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const CHANGED_BY = 'backfill-void-stale-partial-vouchers';

// { cc, voucherId } — reviewed 2026-08-31.
const TARGETS: { cc: number; voucherId: number }[] = [
    { cc: 4411, voucherId: 6078 },
    { cc: 4996, voucherId: 6084 },
    { cc: 6367, voucherId: 8353 },
    { cc: 6437, voucherId: 4249 },
    { cc: 7115, voucherId: 3296 },
    { cc: 7192, voucherId: 6215 },
    { cc: 7406, voucherId: 2154 },
    { cc: 7435, voucherId: 4700 },
    { cc: 7600, voucherId: 8352 },
];

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

async function main() {
    console.log(`\n=== Void stale PARTIALLY_PAID vouchers — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===\n`);

    let voided = 0;
    const skipped: string[] = [];

    for (const t of TARGETS) {
        const v = await prisma.vouchers.findUnique({
            where: { id: t.voucherId },
            select: {
                id: true, student_id: true, status: true, voucher_number: true,
                fee_date: true, issue_date: true,
            },
        });

        if (!v) { skipped.push(`#${t.voucherId} (cc ${t.cc}): not found`); continue; }
        if (v.student_id !== t.cc) { skipped.push(`#${t.voucherId}: belongs to cc ${v.student_id}, expected ${t.cc}`); continue; }
        if (v.status !== 'PARTIALLY_PAID') { skipped.push(`#${t.voucherId} (cc ${t.cc}): status is ${v.status}, not PARTIALLY_PAID`); continue; }

        // Re-verify a strictly-later PAID voucher still exists for this student.
        const laterPaid = await prisma.vouchers.findFirst({
            where: {
                student_id: t.cc,
                status: 'PAID',
                OR: [
                    { issue_date: { gt: v.issue_date ?? new Date(0) } },
                    { AND: [{ issue_date: v.issue_date ?? new Date(0) }, { id: { gt: v.id } }] },
                ],
            },
            select: { id: true, voucher_number: true, issue_date: true },
            orderBy: [{ issue_date: 'asc' }, { id: 'asc' }],
        });
        if (!laterPaid) { skipped.push(`#${t.voucherId} (cc ${t.cc}): no strictly-later PAID voucher — NOT voiding`); continue; }

        const note =
            `Backfill: voided stale PARTIALLY_PAID voucher #${v.id} (no. ${v.voucher_number ?? 'N/A'}, ` +
            `fee ${ymd(v.fee_date)}). Superseded by later PAID voucher #${laterPaid.id} ` +
            `(no. ${laterPaid.voucher_number ?? 'N/A'}); balance already carried and paid there. ` +
            `Cash on this voucher's deposit_allocations left intact.`;

        console.log(
            `${COMMIT ? 'VOID  ' : 'would void'} #${v.id}  cc ${t.cc}  ${v.voucher_number ?? '—'}  ` +
            `fee ${ymd(v.fee_date)}  -> later PAID #${laterPaid.id}`,
        );

        if (COMMIT) {
            await prisma.$transaction([
                prisma.vouchers.update({ where: { id: v.id }, data: { status: 'VOID' } }),
                prisma.audit_logs.create({
                    data: {
                        entity_type: 'VOUCHER',
                        entity_id: String(v.id),
                        action: 'UPDATED',
                        field: 'status',
                        old_value: 'PARTIALLY_PAID',
                        new_value: 'VOID',
                        changed_by: CHANGED_BY,
                        student_id: t.cc,
                        note,
                    },
                }),
            ]);
        }
        voided++;
    }

    console.log(`\n--- ${COMMIT ? 'Done' : 'Dry run'} ---`);
    console.log(`${COMMIT ? 'Voided' : 'Would void'}: ${voided}/${TARGETS.length}`);
    if (skipped.length) {
        console.log(`Skipped: ${skipped.length}`);
        for (const s of skipped) console.log(`  - ${s}`);
    }
    if (!COMMIT) console.log(`\nRe-run with --commit to apply.`);
    console.log('');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
