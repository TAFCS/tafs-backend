/**
 * READ-ONLY AUDIT (TAFSD-283): fee heads left PAID with no deposit behind them
 * after a deposit was cleared.
 *
 * Two clear-deposit bugs, fixed in TAFSD-281 / TAFSD-282, could corrupt data:
 *  - clearDeposit treated a normally generated voucher that carried a rolled-over
 *    'BALANCE PAYMENT OF' head as a split, and hard-deleted it instead of setting
 *    it back to UNPAID (the older balance voucher it had superseded came back);
 *  - that delete path never recomputed heads shared with the reactivated
 *    voucher, so they kept status = PAID / amount_paid with no allocation.
 *
 * This script writes NOTHING. It lists what a human (and finance) must review
 * before any repair:
 *
 *  1. MISMATCHED HEADS — non-discount student_fees rows whose amount_paid differs
 *     from SUM(deposit_allocations.amount) for that row, or that are PAID with no
 *     allocation at all.
 *  2. LIVE VOUCHERS WITH UNBACKED PAID HEADS — UNPAID / OVERDUE / PARTIALLY_PAID /
 *     EXPIRED vouchers carrying a head whose student_fees.status = PAID but which
 *     has no allocation. This is the exact symptom of the bug.
 *  3. VOUCHERS DELETED BY CLEAR-DEPOSIT — VOUCHER/DELETED audit entries logged
 *     under a DEPOSIT/DELETED parent, classified by how the deleted voucher was
 *     created (from its own VOUCHER/CREATED audit note):
 *       SPLIT_CHILD  "created from split of Voucher #…" — the delete was correct;
 *       ISSUED       a normal create()/bulk voucher — the bug; review it;
 *       UNKNOWN      no creation entry found (old data) — review it.
 *     Reactivated predecessors logged alongside the delete are listed too.
 *
 * Students that appear in both (3: ISSUED/UNKNOWN) and (1 or 2) are the likely
 * victims and are listed in the summary.
 *
 * Usage:
 *   npx ts-node scripts/audit-clear-deposit-orphaned-paid-heads.ts
 *   npx ts-node scripts/audit-clear-deposit-orphaned-paid-heads.ts --json > clear-deposit-audit.json
 *   npx ts-node scripts/audit-clear-deposit-orphaned-paid-heads.ts --students=44,5406
 *     Detail per student: the clear-deposit deletes, their recent vouchers, every
 *     fee head that is billed / paid / mismatched (and which live voucher holds it),
 *     and their surviving deposits.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const JSON_OUT = process.argv.includes('--json');
const STUDENTS_ARG = process.argv.find((a) => a.startsWith('--students='));
const DETAIL_STUDENTS = STUDENTS_ARG
    ? STUDENTS_ARG.slice('--students='.length).split(',').map((x) => Number(x.trim())).filter(Number.isFinite)
    : [];
const CENT = 0.01;

type MismatchRow = {
    student_fee_id: number;
    student_id: number;
    status: string;
    description_prefix: string | null;
    fee_date: Date | null;
    amount: number;
    amount_paid: number;
    allocated: number;
    allocation_count: number;
};

type LiveVoucherRow = {
    voucher_id: number;
    voucher_number: string | null;
    voucher_status: string;
    student_id: number;
    student_fee_id: number;
    description_prefix: string | null;
    amount: number;
    amount_paid: number;
};

type DeletedVoucher = {
    audit_id: number;
    changed_at: Date;
    changed_by: string;
    student_id: number | null;
    voucher_id: number;
    deposit_id: string;
    origin: 'SPLIT_CHILD' | 'ISSUED' | 'UNKNOWN';
    reactivated_voucher_ids: number[];
    note: string | null;
};

const num = (v: unknown) => Number(v ?? 0);

async function mismatchedHeads(): Promise<MismatchRow[]> {
    const rows = await prisma.$queryRaw<any[]>`
        SELECT sf.id                     AS student_fee_id,
               sf.student_id             AS student_id,
               sf.status::text           AS status,
               sf.description_prefix     AS description_prefix,
               sf.fee_date               AS fee_date,
               COALESCE(sf.amount, 0)    AS amount,
               COALESCE(sf.amount_paid, 0) AS amount_paid,
               COALESCE(a.allocated, 0)  AS allocated,
               COALESCE(a.cnt, 0)        AS allocation_count
        FROM student_fees sf
        LEFT JOIN (
            SELECT student_fee_id, SUM(amount) AS allocated, COUNT(*) AS cnt
            FROM deposit_allocations
            WHERE student_fee_id IS NOT NULL
            GROUP BY student_fee_id
        ) a ON a.student_fee_id = sf.id
        WHERE COALESCE(sf.is_discount, false) = false
          AND (
                ABS(COALESCE(sf.amount_paid, 0) - COALESCE(a.allocated, 0)) > ${CENT}
             OR (sf.status::text = 'PAID' AND COALESCE(a.cnt, 0) = 0)
          )
        ORDER BY sf.student_id, sf.id`;
    return rows.map((r) => ({
        ...r,
        student_fee_id: num(r.student_fee_id),
        student_id: num(r.student_id),
        amount: num(r.amount),
        amount_paid: num(r.amount_paid),
        allocated: num(r.allocated),
        allocation_count: num(r.allocation_count),
    }));
}

async function liveVouchersWithUnbackedPaidHeads(): Promise<LiveVoucherRow[]> {
    const rows = await prisma.$queryRaw<any[]>`
        SELECT v.id                   AS voucher_id,
               v.voucher_number       AS voucher_number,
               v.status               AS voucher_status,
               v.student_id           AS student_id,
               sf.id                  AS student_fee_id,
               sf.description_prefix  AS description_prefix,
               COALESCE(sf.amount, 0) AS amount,
               COALESCE(sf.amount_paid, 0) AS amount_paid
        FROM vouchers v
        JOIN voucher_heads vh ON vh.voucher_id = v.id
        JOIN student_fees sf  ON sf.id = vh.student_fee_id
        WHERE v.status IN ('UNPAID', 'OVERDUE', 'PARTIALLY_PAID', 'EXPIRED')
          AND COALESCE(sf.is_discount, false) = false
          AND sf.status::text = 'PAID'
          AND NOT EXISTS (
              SELECT 1 FROM deposit_allocations da WHERE da.student_fee_id = sf.id
          )
        ORDER BY v.student_id, v.id, sf.id`;
    return rows.map((r) => ({
        ...r,
        voucher_id: num(r.voucher_id),
        student_id: num(r.student_id),
        student_fee_id: num(r.student_fee_id),
        amount: num(r.amount),
        amount_paid: num(r.amount_paid),
    }));
}

async function vouchersDeletedByClearDeposit(): Promise<DeletedVoucher[]> {
    const deletes = await prisma.audit_logs.findMany({
        where: {
            entity_type: 'VOUCHER',
            action: 'DELETED',
            parent: { entity_type: 'DEPOSIT', action: 'DELETED' },
        },
        include: { parent: { select: { id: true, entity_id: true } } },
        orderBy: { changed_at: 'asc' },
    });
    if (deletes.length === 0) return [];

    const voucherIds = [...new Set(deletes.map((d) => d.entity_id))];
    const created = await prisma.audit_logs.findMany({
        where: { entity_type: 'VOUCHER', action: 'CREATED', entity_id: { in: voucherIds } },
        select: { entity_id: true, note: true },
    });
    const createdNote = new Map<string, string>();
    for (const c of created) createdNote.set(c.entity_id, c.note ?? '');

    const parentIds = [...new Set(deletes.map((d) => d.parent_id!).filter(Boolean))];
    const reactivations = await prisma.audit_logs.findMany({
        where: {
            parent_id: { in: parentIds },
            entity_type: 'VOUCHER',
            action: 'UPDATED',
            field: 'status',
            old_value: 'VOID',
        },
        select: { parent_id: true, entity_id: true },
    });
    const reactivatedByParent = new Map<number, number[]>();
    for (const r of reactivations) {
        const list = reactivatedByParent.get(r.parent_id!) ?? [];
        list.push(Number(r.entity_id));
        reactivatedByParent.set(r.parent_id!, list);
    }

    return deletes.map((d) => {
        const note = createdNote.get(d.entity_id);
        const origin: DeletedVoucher['origin'] = note == null
            ? 'UNKNOWN'
            : /created from split of Voucher/i.test(note) ? 'SPLIT_CHILD' : 'ISSUED';
        return {
            audit_id: d.id,
            changed_at: d.changed_at,
            changed_by: d.changed_by,
            student_id: d.student_id,
            voucher_id: Number(d.entity_id),
            deposit_id: d.parent?.entity_id ?? '?',
            origin,
            reactivated_voucher_ids: reactivatedByParent.get(d.parent_id!) ?? [],
            note: d.note,
        };
    });
}

async function studentDetail(studentId: number, deleted: DeletedVoucher[]) {
    console.log(`\n──────── Student ${studentId} ────────`);

    const mine = deleted.filter((d) => d.student_id === studentId);
    console.log(`Clear-deposit deletes: ${mine.length}`);
    for (const d of mine) {
        console.log(`  ${d.changed_at.toISOString().slice(0, 16)} by ${d.changed_by}: voucher #${d.voucher_id} [${d.origin}], deposit #${d.deposit_id}` +
            `${d.reactivated_voucher_ids.length ? `, reactivated #${d.reactivated_voucher_ids.join(', #')}` : ''}`);
        if (d.note) console.log(`    ${d.note}`);
    }

    const vouchers = await prisma.vouchers.findMany({
        where: { student_id: studentId },
        orderBy: { id: 'desc' },
        take: 12,
        select: {
            id: true, voucher_number: true, status: true, fee_date: true, due_date: true,
            total_payable_before_due: true, superseded_by_voucher_id: true, split_parent_id: true,
        },
    });
    console.log('Vouchers (latest 12):');
    console.table(vouchers.map((v) => ({
        id: v.id,
        number: v.voucher_number ?? '',
        status: v.status,
        fee_date: v.fee_date?.toISOString().slice(0, 10) ?? '',
        due: v.due_date.toISOString().slice(0, 10),
        total: num(v.total_payable_before_due),
        superseded_by: v.superseded_by_voucher_id ?? '',
        split_parent: v.split_parent_id ?? '',
    })));

    const heads = await prisma.$queryRaw<any[]>`
        SELECT sf.id, sf.description_prefix, sf.fee_date, sf.status::text AS status,
               COALESCE(sf.amount, 0) AS amount, COALESCE(sf.amount_paid, 0) AS amount_paid,
               COALESCE((SELECT SUM(da.amount) FROM deposit_allocations da WHERE da.student_fee_id = sf.id), 0) AS allocated,
               (SELECT string_agg(v.id || ':' || v.status, ', ' ORDER BY v.id)
                  FROM voucher_heads vh JOIN vouchers v ON v.id = vh.voucher_id
                 WHERE vh.student_fee_id = sf.id AND v.status <> 'VOID') AS live_vouchers
        FROM student_fees sf
        WHERE sf.student_id = ${studentId}
          AND COALESCE(sf.is_discount, false) = false
          AND sf.status::text <> 'NOT_ISSUED'
        ORDER BY sf.fee_date DESC NULLS LAST, sf.id DESC
        LIMIT 30`;
    console.log('Issued / paid fee heads (latest 30; ⚠ = amount_paid ≠ allocations):');
    console.table(heads.map((h) => ({
        fee: num(h.id),
        flag: Math.abs(num(h.amount_paid) - num(h.allocated)) > CENT ? '⚠' : '',
        prefix: h.description_prefix ?? '',
        fee_date: h.fee_date ? new Date(h.fee_date).toISOString().slice(0, 10) : '',
        status: h.status,
        amount: num(h.amount),
        amount_paid: num(h.amount_paid),
        allocated: num(h.allocated),
        live_vouchers: h.live_vouchers ?? '',
    })));

    const deposits = await prisma.deposits.findMany({
        where: { student_id: studentId },
        orderBy: { id: 'desc' },
        take: 10,
        include: { deposit_allocations: { select: { voucher_id: true, amount: true } } },
    });
    console.log('Surviving deposits (latest 10):');
    console.table(deposits.map((d) => ({
        id: d.id,
        date: d.deposit_date.toISOString().slice(0, 10),
        total: num(d.total_amount),
        ref: d.reference_number ?? '',
        vouchers: [...new Set(d.deposit_allocations.map((a) => a.voucher_id))].join(', '),
    })));
}

async function main() {
    if (DETAIL_STUDENTS.length > 0) {
        const deleted = await vouchersDeletedByClearDeposit();
        for (const sid of DETAIL_STUDENTS) await studentDetail(sid, deleted);
        console.log('\nNothing was written.\n');
        return;
    }

    const [mismatches, liveVouchers, deleted] = await Promise.all([
        mismatchedHeads(),
        liveVouchersWithUnbackedPaidHeads(),
        vouchersDeletedByClearDeposit(),
    ]);

    const suspectDeletes = deleted.filter((d) => d.origin !== 'SPLIT_CHILD');
    const corruptedStudents = new Set<number>([
        ...mismatches.map((m) => m.student_id),
        ...liveVouchers.map((v) => v.student_id),
    ]);
    const likelyVictims = [...new Set(
        suspectDeletes
            .map((d) => d.student_id)
            .filter((s): s is number => s != null && corruptedStudents.has(s)),
    )].sort((a, b) => a - b);

    if (JSON_OUT) {
        console.log(JSON.stringify({ mismatches, liveVouchers, deleted, likelyVictims }, null, 2));
        return;
    }

    console.log('\n=== Clear-deposit orphaned PAID heads audit (READ ONLY) ===\n');

    console.log(`1. Mismatched heads (amount_paid ≠ allocations, or PAID with none): ${mismatches.length}`);
    const paidNoAlloc = mismatches.filter((m) => m.status === 'PAID' && m.allocation_count === 0);
    console.log(`   of which PAID with no allocation: ${paidNoAlloc.length}`);
    if (mismatches.length > 0) {
        console.table(mismatches.slice(0, 50).map((m) => ({
            student: m.student_id,
            fee: m.student_fee_id,
            status: m.status,
            prefix: m.description_prefix ?? '',
            amount: m.amount,
            amount_paid: m.amount_paid,
            allocated: m.allocated,
        })));
        if (mismatches.length > 50) console.log(`   … ${mismatches.length - 50} more (use --json for all)`);
    }

    console.log(`\n2. Live vouchers holding a PAID head with no allocation: ${new Set(liveVouchers.map((v) => v.voucher_id)).size} voucher(s), ${liveVouchers.length} head(s)`);
    if (liveVouchers.length > 0) {
        console.table(liveVouchers.slice(0, 50).map((v) => ({
            student: v.student_id,
            voucher: v.voucher_id,
            number: v.voucher_number ?? '',
            status: v.voucher_status,
            fee: v.student_fee_id,
            prefix: v.description_prefix ?? '',
            amount_paid: v.amount_paid,
        })));
        if (liveVouchers.length > 50) console.log(`   … ${liveVouchers.length - 50} more (use --json for all)`);
    }

    const byOrigin = (o: DeletedVoucher['origin']) => deleted.filter((d) => d.origin === o).length;
    console.log(`\n3. Vouchers deleted by clear-deposit: ${deleted.length} (SPLIT_CHILD ${byOrigin('SPLIT_CHILD')}, ISSUED ${byOrigin('ISSUED')}, UNKNOWN ${byOrigin('UNKNOWN')})`);
    if (suspectDeletes.length > 0) {
        console.table(suspectDeletes.map((d) => ({
            when: d.changed_at.toISOString().slice(0, 10),
            by: d.changed_by,
            student: d.student_id ?? '',
            deleted_voucher: d.voucher_id,
            deposit: d.deposit_id,
            origin: d.origin,
            reactivated: d.reactivated_voucher_ids.join(', '),
        })));
    }

    console.log(`\nLikely victims (suspect delete AND a corrupted head): ${likelyVictims.length}`);
    if (likelyVictims.length > 0) console.log(`   students: ${likelyVictims.join(', ')}`);
    console.log('\nNothing was written. Review with finance before any repair.\n');
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
