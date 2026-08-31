/**
 * READ-ONLY: print the full voucher timeline for one or more students, oldest to
 * newest, with status / balance / deposits — and for each PARTIALLY_PAID voucher
 * say whether a LATER voucher exists and whether any later voucher is PAID.
 *
 * Usage:
 *   npx ts-node scripts/inspect-student-voucher-timeline.ts 4411 4996 6367 ...
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CCS = process.argv.slice(2).map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));

const num = (d: any) => (d == null ? 0 : Number(d));
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

async function main() {
    if (CCS.length === 0) {
        console.error('Pass one or more student CC numbers.');
        process.exit(1);
    }

    const vouchers = await prisma.vouchers.findMany({
        where: { student_id: { in: CCS } },
        select: {
            id: true, student_id: true, status: true, voucher_number: true,
            fee_date: true, issue_date: true, generated_at: true,
            total_payable_before_due: true, total_arrears: true, split_parent_id: true,
        },
    });

    const dep = await prisma.deposit_allocations.groupBy({
        by: ['voucher_id'],
        where: { voucher_id: { in: vouchers.map((v) => v.id) } },
        _sum: { amount: true },
    });
    const paidBy = new Map<number, number>();
    for (const r of dep) if (r.voucher_id != null) paidBy.set(r.voucher_id, num(r._sum.amount));

    const students = await prisma.students.findMany({
        where: { cc: { in: CCS } },
        select: { cc: true, gr_number: true, full_name: true, status: true },
    });
    const stu = new Map(students.map((s) => [s.cc, s]));

    const byRecency = (a: any, b: any) => {
        const ta = a.issue_date ? a.issue_date.getTime() : 0;
        const tb = b.issue_date ? b.issue_date.getTime() : 0;
        if (ta !== tb) return ta - tb;
        return a.id - b.id;
    };

    for (const cc of CCS) {
        const s = stu.get(cc);
        const list = vouchers.filter((v) => v.student_id === cc).sort(byRecency);
        console.log(`\n════ CC ${cc}  GR ${s?.gr_number ?? '—'}  ${s?.full_name ?? '—'}  [${s?.status ?? '?'}] ════`);
        if (list.length === 0) { console.log('  (no vouchers)'); continue; }

        for (let i = 0; i < list.length; i++) {
            const v = list[i];
            const paid = paidBy.get(v.id) ?? 0;
            const payable = num(v.total_payable_before_due);
            const later = list.slice(i + 1);
            const laterPaid = later.filter((x) => x.status === 'PAID');
            const flag =
                v.status === 'PARTIALLY_PAID'
                    ? later.length === 0
                        ? '  <-- PARTIALLY_PAID, NO later voucher'
                        : laterPaid.length > 0
                            ? `  <-- PARTIALLY_PAID; later PAID voucher(s): ${laterPaid.map((x) => '#' + x.id).join(', ')}`
                            : `  <-- PARTIALLY_PAID; ${later.length} later voucher(s), none PAID (${later.map((x) => x.status).join('/')})`
                    : '';
            console.log(
                `  ${String(i + 1).padStart(2)}. #${String(v.id).padEnd(7)} ${(v.voucher_number ?? '—').padEnd(12)} ` +
                `${String(v.status ?? 'null').padEnd(15)} fee ${ymd(v.fee_date)}  issued ${ymd(v.issue_date)}  ` +
                `payable ${payable.toFixed(0).padStart(7)}  paid ${paid.toFixed(0).padStart(7)}  bal ${(payable - paid).toFixed(0).padStart(7)}` +
                `${v.split_parent_id != null ? '  (split child)' : ''}${flag}`,
            );
        }
    }
    console.log('');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
