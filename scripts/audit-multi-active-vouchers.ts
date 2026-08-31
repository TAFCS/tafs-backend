/**
 * READ-ONLY AUDIT: which students currently have more than one ACTIVE voucher.
 *
 * "Active" = status in { UNPAID, OVERDUE, EXPIRED, PARTIALLY_PAID } (a NULL
 * status is treated as UNPAID, per the column default). PAID and VOID do NOT
 * count as active.
 *
 * Ideal end state (what the follow-up backfill will enforce): every student has
 * exactly ONE active voucher and it is that student's most-recent voucher.
 *
 * This script writes NOTHING. It only produces the list so a human can review it
 * before the void backfill is run.
 *
 * Findings emitted per row:
 *   MULTI_ACTIVE               the student has >1 active voucher. The most-recent
 *                              active one is marked KEEP; every older active one
 *                              is a VOID_CANDIDATE.
 *   SINGLE_ACTIVE_NOT_LATEST   the student has exactly 1 active voucher but it is
 *                              NOT their most-recent voucher overall (the newest
 *                              voucher is PAID/VOID/etc). Only emitted with
 *                              --include-stale-single. Verdict REVIEW.
 *
 * Per-student column `latest_overall_status` shows the status of the student's
 * newest voucher of ANY status, so you can spot cases where the voucher we'd
 * KEEP is not actually the newest one on the account.
 *
 * Usage:
 *   npx ts-node scripts/audit-multi-active-vouchers.ts
 *   npx ts-node scripts/audit-multi-active-vouchers.ts --csv > multi-active-vouchers.csv
 *   npx ts-node scripts/audit-multi-active-vouchers.ts --include-stale-single --csv > voucher-anomalies.csv
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CSV = process.argv.includes('--csv');
const INCLUDE_STALE_SINGLE = process.argv.includes('--include-stale-single');

const ACTIVE = new Set(['UNPAID', 'OVERDUE', 'EXPIRED', 'PARTIALLY_PAID']);
const normStatus = (s: string | null) => (s == null || s === '' ? 'UNPAID' : s);
const isActive = (s: string | null) => ACTIVE.has(normStatus(s));

type V = {
    id: number;
    student_id: number;
    status: string | null;
    fee_date: Date | null;
    issue_date: Date | null;
    generated_at: Date | null;
    voucher_number: string | null;
    total_payable_before_due: any;
    total_arrears: any;
    split_parent_id: number | null;
};

/** Most-recent-first: issue_date desc, then id desc (id is autoincrement = creation order). */
const byRecencyDesc = (a: V, b: V) => {
    const ta = a.issue_date ? a.issue_date.getTime() : 0;
    const tb = b.issue_date ? b.issue_date.getTime() : 0;
    if (ta !== tb) return tb - ta;
    return b.id - a.id;
};

const num = (d: any) => (d == null ? 0 : Number(d));
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
const iso = (d: Date | null) => (d ? d.toISOString() : '');

async function main() {
    if (!CSV) console.log('\n=== Multi-active-voucher audit (READ ONLY) ===\n');

    const vouchers = (await prisma.vouchers.findMany({
        select: {
            id: true,
            student_id: true,
            status: true,
            fee_date: true,
            issue_date: true,
            generated_at: true,
            voucher_number: true,
            total_payable_before_due: true,
            total_arrears: true,
            split_parent_id: true,
        },
    })) as V[];

    // Cash received per voucher, so PARTIALLY_PAID rows show a real balance.
    const depRows = await prisma.deposit_allocations.groupBy({
        by: ['voucher_id'],
        where: { voucher_id: { not: null } },
        _sum: { amount: true },
    });
    const depositedByVoucher = new Map<number, number>();
    for (const r of depRows) {
        if (r.voucher_id != null) depositedByVoucher.set(r.voucher_id, num(r._sum.amount));
    }

    // Group by student.
    const byStudent = new Map<number, V[]>();
    for (const v of vouchers) {
        if (!byStudent.has(v.student_id)) byStudent.set(v.student_id, []);
        byStudent.get(v.student_id)!.push(v);
    }

    type FlaggedRow = {
        finding: 'MULTI_ACTIVE' | 'SINGLE_ACTIVE_NOT_LATEST';
        student_id: number;
        active_count: number;
        latest_overall_id: number;
        latest_overall_status: string;
        latest_overall_is_active: boolean;
        v: V;
        verdict: 'KEEP' | 'VOID_CANDIDATE' | 'REVIEW';
    };

    const flagged: FlaggedRow[] = [];
    let multiActiveStudents = 0;
    let staleSingleStudents = 0;
    let totalVoidCandidates = 0;

    for (const [studentId, list] of byStudent) {
        const active = list.filter((v) => isActive(v.status)).sort(byRecencyDesc);
        const latestOverall = [...list].sort(byRecencyDesc)[0];
        const latestOverallActive = isActive(latestOverall.status);

        if (active.length > 1) {
            multiActiveStudents++;
            const keeper = active[0]; // most-recent active
            for (const v of active) {
                const verdict = v.id === keeper.id ? 'KEEP' : 'VOID_CANDIDATE';
                if (verdict === 'VOID_CANDIDATE') totalVoidCandidates++;
                flagged.push({
                    finding: 'MULTI_ACTIVE',
                    student_id: studentId,
                    active_count: active.length,
                    latest_overall_id: latestOverall.id,
                    latest_overall_status: normStatus(latestOverall.status),
                    latest_overall_is_active: latestOverallActive,
                    v,
                    verdict,
                });
            }
        } else if (active.length === 1 && !latestOverallActive && INCLUDE_STALE_SINGLE) {
            // Exactly one active voucher, but it's not the newest voucher on the account.
            staleSingleStudents++;
            flagged.push({
                finding: 'SINGLE_ACTIVE_NOT_LATEST',
                student_id: studentId,
                active_count: 1,
                latest_overall_id: latestOverall.id,
                latest_overall_status: normStatus(latestOverall.status),
                latest_overall_is_active: false,
                v: active[0],
                verdict: 'REVIEW',
            });
        }
    }

    // Enrich with student identity.
    const studentIds = [...new Set(flagged.map((f) => f.student_id))];
    const students = await prisma.students.findMany({
        where: { cc: { in: studentIds } },
        select: { cc: true, gr_number: true, full_name: true, status: true, deleted_at: true, campus_id: true },
    });
    const stu = new Map(students.map((s) => [s.cc, s]));

    // Sort output: worst offenders first, then by student, then most-recent voucher first.
    flagged.sort((a, b) => {
        if (a.active_count !== b.active_count) return b.active_count - a.active_count;
        if (a.student_id !== b.student_id) return a.student_id - b.student_id;
        return byRecencyDesc(a.v, b.v);
    });

    if (CSV) {
        const cols = [
            'finding', 'verdict', 'cc', 'gr_number', 'full_name', 'student_status', 'student_deleted',
            'campus_id', 'active_voucher_count',
            'voucher_id', 'voucher_number', 'voucher_status', 'is_split_child',
            'fee_date', 'issue_date', 'generated_at',
            'payable', 'deposited', 'balance', 'total_arrears',
            'latest_overall_voucher_id', 'latest_overall_status', 'keep_voucher_is_newest_overall',
        ];
        console.log(cols.join(','));
        for (const f of flagged) {
            const s = stu.get(f.student_id);
            const payable = num(f.v.total_payable_before_due);
            const deposited = depositedByVoucher.get(f.v.id) ?? 0;
            const keepIsNewest =
                f.finding === 'MULTI_ACTIVE' && f.verdict === 'KEEP'
                    ? f.v.id === f.latest_overall_id
                    : '';
            const row = [
                f.finding,
                f.verdict,
                f.student_id,
                csv(s?.gr_number ?? ''),
                csv(s?.full_name ?? ''),
                s?.status ?? '',
                s?.deleted_at ? 'yes' : 'no',
                s?.campus_id ?? '',
                f.active_count,
                f.v.id,
                csv(f.v.voucher_number ?? ''),
                normStatus(f.v.status),
                f.v.split_parent_id != null ? 'yes' : 'no',
                ymd(f.v.fee_date),
                ymd(f.v.issue_date),
                iso(f.v.generated_at),
                payable.toFixed(2),
                deposited.toFixed(2),
                (payable - deposited).toFixed(2),
                num(f.v.total_arrears).toFixed(2),
                f.latest_overall_id,
                f.latest_overall_status,
                keepIsNewest === '' ? '' : keepIsNewest ? 'yes' : 'no',
            ];
            console.log(row.join(','));
        }
        return;
    }

    // Human-readable console report.
    let lastStudent = -1;
    for (const f of flagged) {
        if (f.student_id !== lastStudent) {
            lastStudent = f.student_id;
            const s = stu.get(f.student_id);
            const tag = f.finding === 'MULTI_ACTIVE' ? `${f.active_count} ACTIVE` : 'STALE SINGLE ACTIVE';
            console.log(
                `\nCC ${f.student_id}  GR ${s?.gr_number ?? '—'}  ${s?.full_name ?? '—'}  ` +
                `[${s?.status ?? '?'}${s?.deleted_at ? ', DELETED' : ''}]  — ${tag}`,
            );
            if (f.finding === 'MULTI_ACTIVE' && !f.latest_overall_is_active) {
                console.log(
                    `   ! newest voucher on this account is #${f.latest_overall_id} (${f.latest_overall_status}), ` +
                    `not an active one — confirm the KEEP choice.`,
                );
            }
        }
        const s = normStatus(f.v.status);
        const payable = num(f.v.total_payable_before_due);
        const deposited = depositedByVoucher.get(f.v.id) ?? 0;
        const bal = payable - deposited;
        console.log(
            `   ${f.verdict.padEnd(14)} #${String(f.v.id).padEnd(7)} ${(f.v.voucher_number ?? '—').padEnd(12)} ` +
            `${s.padEnd(15)} fee ${ymd(f.v.fee_date) || '—'}  issued ${ymd(f.v.issue_date) || '—'}  ` +
            `payable ${payable.toFixed(0)}  paid ${deposited.toFixed(0)}  bal ${bal.toFixed(0)}` +
            `${f.v.split_parent_id != null ? '  (split child)' : ''}`,
        );
    }

    console.log('\n--- Summary ---');
    console.log(`Students scanned                        : ${byStudent.size}`);
    console.log(`Students with >1 active voucher         : ${multiActiveStudents}`);
    console.log(`  -> active vouchers to void (backfill) : ${totalVoidCandidates}`);
    if (INCLUDE_STALE_SINGLE) {
        console.log(`Students with 1 active but not newest   : ${staleSingleStudents}`);
    } else {
        console.log(`(run with --include-stale-single to also list students whose one active voucher isn't their newest)`);
    }
    console.log(`\nRe-run with --csv to export. Nothing was modified.\n`);
}

function csv(v: string) {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
