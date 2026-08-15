/**
 * READ-ONLY verification report for the term_start_month fix.
 *
 * For every fee head, renders its month+year label the OLD way (term inferred
 * from the student's current class) and the NEW way (term taken from
 * student_fees.term_start_month, falling back to the current class), and prints
 * only the rows that differ.
 *
 * Run it after the backfill. What you should see:
 *   - Every changed row has target_month in 4..7 (Apr-Jul). Those are the only
 *     months on which an Aug-Jul and an Apr-Mar term can disagree; a change
 *     outside that window means the fix is wrong.
 *   - Every changed row belongs to a student who actually crossed term systems.
 *     A change on a student who never moved means the backfill resolved a class
 *     it should not have.
 *
 * Usage:
 *   npx ts-node scripts/report-term-label-changes.ts
 *
 * Writes nothing.
 */
import { PrismaClient } from '@prisma/client';
import { getMonthYearLabel, termOfHead } from '../src/common/utils/academic-labels';

const prisma = new PrismaClient();
const DEFAULT_TERM_START_MONTH = 8;

async function main() {
    console.log('\n=== term label before/after report (read-only) ===\n');

    const classTerms = new Map<number, number>(
        (await prisma.classes.findMany({ select: { id: true, term_start_month: true } }))
            .map((c) => [c.id, c.term_start_month]),
    );

    const fees = await prisma.student_fees.findMany({
        select: {
            id: true,
            student_id: true,
            target_month: true,
            academic_year: true,
            term_start_month: true,
            students: { select: { class_id: true, full_name: true, gr_number: true } },
        },
        orderBy: [{ student_id: 'asc' }, { id: 'asc' }],
    });

    console.log(`Scanned ${fees.length} head(s).\n`);

    type Row = {
        id: number;
        month: number;
        academicYear: string;
        before: string;
        after: string;
    };
    const byStudent = new Map<number, { name: string; gr: string; rows: Row[] }>();
    let outsideAprJul = 0;

    for (const fee of fees) {
        if (fee.target_month == null || !fee.academic_year) continue;

        const currentClassId = fee.students?.class_id ?? undefined;
        // OLD: the term the reader inferred from whatever class it was looking through.
        const before = getMonthYearLabel(fee.target_month, fee.academic_year, {
            classId: currentClassId,
            classTerms,
        });
        // NEW: the term the head was actually written under.
        const after = getMonthYearLabel(
            fee.target_month,
            fee.academic_year,
            termOfHead(fee, { classId: currentClassId, classTerms }),
        );

        if (before === after) continue;

        if (fee.target_month < 4 || fee.target_month > 7) outsideAprJul++;

        if (!byStudent.has(fee.student_id)) {
            byStudent.set(fee.student_id, {
                name: fee.students?.full_name ?? '(unknown)',
                gr: fee.students?.gr_number ?? 'N/A',
                rows: [],
            });
        }
        byStudent.get(fee.student_id)!.rows.push({
            id: fee.id,
            month: fee.target_month,
            academicYear: fee.academic_year,
            before,
            after,
        });
    }

    const totalChanged = [...byStudent.values()].reduce((n, s) => n + s.rows.length, 0);
    console.log(`${totalChanged} label(s) change, across ${byStudent.size} student(s).\n`);

    for (const [studentId, s] of byStudent) {
        console.log(`  CC ${studentId} — ${s.name} (GR ${s.gr}) — ${s.rows.length} head(s)`);
        for (const r of s.rows) {
            console.log(
                `      fee #${String(r.id).padStart(6)}  m=${String(r.month).padStart(2)}  ${r.academicYear}` +
                `   "${r.before}"  ->  "${r.after}"`,
            );
        }
    }

    console.log('');
    if (outsideAprJul > 0) {
        console.log(`!! ${outsideAprJul} changed label(s) fall OUTSIDE Apr-Jul.`);
        console.log('   Aug-Jul and Apr-Mar terms cannot disagree on those months — investigate before shipping.\n');
    } else {
        console.log('OK: every changed label is in the Apr-Jul window, as expected.\n');
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
