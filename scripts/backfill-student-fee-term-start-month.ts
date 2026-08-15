/**
 * One-off backfill: populate student_fees.term_start_month.
 *
 * (target_month, academic_year) is ambiguous on its own — "June of 2025-2026" is
 * June 2026 on an Aug-Jul term and June 2025 on an Apr-Mar one. Until this column
 * is filled, every label resolves that from whichever class the head is being
 * *viewed* through, so a student moved between term systems has all their
 * pre-move heads relabelled a year out in the arrears and payment-history columns.
 *
 * Resolution, in priority order:
 *   1. The EARLIEST voucher this head was ever billed on -> vouchers.class_id.
 *      vouchers.class_id is a snapshot of the student's class at generation time
 *      and is the only per-billing class record in the schema.
 *   2. The student's current class, for heads that were never billed. Those are
 *      current/future-period heads, where the current class is the right answer.
 *   3. Otherwise left NULL — readers keep their existing fallback behaviour.
 *
 * Two traps this deliberately avoids, both measured against the June-2026 dump:
 *   - It does NOT filter out VOID vouchers. Of the 1,219 heads that appear on 2+
 *     vouchers, the earliest is VOID in 1,194 (98%) — arrear re-billing voids the
 *     old voucher and carries the head onto a new one. Skipping VOID would pick
 *     the LATEST voucher and return the wrong class in precisely the cases this
 *     backfill exists to fix.
 *   - It orders by (issue_date, id), not issue_date alone: 131 heads have tied
 *     issue_dates, so issue_date is not a total order.
 *
 * Usage:
 *   DRY_RUN=true npx ts-node scripts/backfill-student-fee-term-start-month.ts
 *   npx ts-node scripts/backfill-student-fee-term-start-month.ts
 *
 * Reversible: UPDATE student_fees SET term_start_month = NULL;
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DRY_RUN = process.env.DRY_RUN === 'true';
const DEFAULT_TERM_START_MONTH = 8;
const BATCH_SIZE = 500;

type Resolution = 'voucher' | 'current-class' | 'unresolved';

async function main() {
    console.log(`\n=== student_fees.term_start_month backfill ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

    const classTerms = new Map<number, number>(
        (await prisma.classes.findMany({ select: { id: true, term_start_month: true } }))
            .map((c) => [c.id, c.term_start_month]),
    );
    console.log(`Loaded ${classTerms.size} classes.`);
    const nonDefault = [...classTerms.entries()].filter(([, t]) => t !== DEFAULT_TERM_START_MONTH);
    console.log(`Non-default terms: ${nonDefault.map(([id, t]) => `class ${id}=${t}`).join(', ') || 'none'}\n`);

    // Only ever fills NULLs, so the script is idempotent and re-runnable.
    const fees = await prisma.student_fees.findMany({
        where: { term_start_month: null },
        select: {
            id: true,
            student_id: true,
            target_month: true,
            academic_year: true,
            students: { select: { class_id: true } },
            voucher_heads: {
                select: { vouchers: { select: { class_id: true, issue_date: true, id: true } } },
            },
        },
    });
    console.log(`${fees.length} head(s) with term_start_month IS NULL.\n`);

    const counts: Record<Resolution, number> = { voucher: 0, 'current-class': 0, unresolved: 0 };
    const updates: { id: number; term: number }[] = [];
    // Heads whose resolved term disagrees with what a reader would infer today
    // from the student's CURRENT class. This is exactly the set whose rendered
    // labels will change once the backfill lands.
    const changed: {
        id: number;
        student_id: number;
        target_month: number;
        academic_year: string;
        resolved: number;
        currentClassTerm: number;
    }[] = [];

    for (const fee of fees) {
        const currentClassTerm = fee.students?.class_id != null
            ? (classTerms.get(fee.students.class_id) ?? DEFAULT_TERM_START_MONTH)
            : DEFAULT_TERM_START_MONTH;

        const billingVouchers = fee.voucher_heads
            .map((vh) => vh.vouchers)
            .filter((v): v is NonNullable<typeof v> => v != null)
            .sort((a, b) => {
                const at = a.issue_date ? new Date(a.issue_date).getTime() : 0;
                const bt = b.issue_date ? new Date(b.issue_date).getTime() : 0;
                return at - bt || a.id - b.id;
            });

        let resolved: number | null = null;
        let how: Resolution = 'unresolved';

        const originalClassId = billingVouchers[0]?.class_id;
        if (originalClassId != null && classTerms.has(originalClassId)) {
            resolved = classTerms.get(originalClassId)!;
            how = 'voucher';
        } else if (fee.students?.class_id != null && classTerms.has(fee.students.class_id)) {
            resolved = classTerms.get(fee.students.class_id)!;
            how = 'current-class';
        }

        counts[how]++;
        if (resolved == null) continue;

        updates.push({ id: fee.id, term: resolved });
        if (resolved !== currentClassTerm) {
            changed.push({
                id: fee.id,
                student_id: fee.student_id,
                target_month: fee.target_month,
                academic_year: fee.academic_year,
                resolved,
                currentClassTerm,
            });
        }
    }

    console.log('Resolution source:');
    console.log(`  from earliest billing voucher : ${counts.voucher}`);
    console.log(`  from student's current class  : ${counts['current-class']}`);
    console.log(`  unresolved (left NULL)        : ${counts.unresolved}\n`);

    console.log(`Heads whose term differs from their student's CURRENT class: ${changed.length}`);
    if (changed.length > 0) {
        const byStudent = new Map<number, typeof changed>();
        for (const c of changed) {
            if (!byStudent.has(c.student_id)) byStudent.set(c.student_id, []);
            byStudent.get(c.student_id)!.push(c);
        }
        console.log(`Across ${byStudent.size} student(s). These are the labels that will change:\n`);
        for (const [studentId, rows] of byStudent) {
            console.log(`  student #${studentId} — ${rows.length} head(s)`);
            for (const r of rows.slice(0, 12)) {
                console.log(
                    `    fee #${r.id}  month=${String(r.target_month).padStart(2)}  ${r.academic_year}` +
                    `  term ${r.currentClassTerm} -> ${r.resolved}`,
                );
            }
            if (rows.length > 12) console.log(`    ... and ${rows.length - 12} more`);
        }
        console.log('');
    }

    if (DRY_RUN) {
        console.log(`DRY RUN — would update ${updates.length} row(s). Nothing written.\n`);
        return;
    }

    // Group by term value so this is a handful of UPDATE ... WHERE id IN (...)
    // statements rather than one round-trip per row.
    const byTerm = new Map<number, number[]>();
    for (const u of updates) {
        if (!byTerm.has(u.term)) byTerm.set(u.term, []);
        byTerm.get(u.term)!.push(u.id);
    }

    let written = 0;
    for (const [term, ids] of byTerm) {
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const batch = ids.slice(i, i + BATCH_SIZE);
            const res = await prisma.student_fees.updateMany({
                where: { id: { in: batch } },
                data: { term_start_month: term },
            });
            written += res.count;
        }
        console.log(`  term_start_month = ${term}: ${ids.length} row(s)`);
    }

    console.log(`\nDone. ${written} row(s) updated.\n`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
