/**
 * BACKFILL: void the 24 "older active" vouchers for students who currently hold
 * more than one active voucher (see scripts/audit-multi-active-vouchers.ts).
 * Each pinned by { cc, keepId, voidId }.
 *
 * Per candidate it first checks whether the KEEPER voucher already carries every
 * still-outstanding fee head of the VOID candidate:
 *
 *   SAFE   every unpaid non-discount head of the void candidate is also a head
 *          on the keeper -> voiding leaves no receivable homeless.
 *   HELD   the keeper does NOT cover some outstanding head(s) -> voiding would
 *          leave that amount on no active voucher until the student's next
 *          voucher is generated. Listed with the uncovered amount; NOT voided
 *          unless --force-all.
 *
 * Voiding only flips vouchers.status -> 'VOID' and writes an audit_logs row.
 * student_fees / deposit_allocations / voucher_heads are left untouched (cash
 * stays recorded; the fee row keeps its own outstanding balance).
 *
 * Usage:
 *   npx ts-node scripts/backfill-void-multi-active-vouchers.ts               # dry run, SAFE only
 *   npx ts-node scripts/backfill-void-multi-active-vouchers.ts --commit      # apply SAFE only
 *   npx ts-node scripts/backfill-void-multi-active-vouchers.ts --commit --force-all   # apply ALL 24
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const FORCE_ALL = process.argv.includes('--force-all');
const CHANGED_BY = 'backfill-void-multi-active-vouchers';

// { cc, keepId, voidId } — from the multi-active audit, reviewed 2026-08-31.
const TARGETS: { cc: number; keepId: number; voidId: number }[] = [
    { cc: 4132, keepId: 9980, voidId: 6150 },
    { cc: 4554, keepId: 9933, voidId: 8357 },
    { cc: 4846, keepId: 9883, voidId: 8356 },
    { cc: 5346, keepId: 9981, voidId: 3234 },
    { cc: 5406, keepId: 6080, voidId: 5023 },
    { cc: 5426, keepId: 9810, voidId: 8355 },
    { cc: 5626, keepId: 9485, voidId: 5730 },
    { cc: 6089, keepId: 9435, voidId: 8354 },
    { cc: 6121, keepId: 10175, voidId: 4428 },
    { cc: 6536, keepId: 9317, voidId: 3637 },
    { cc: 6739, keepId: 9276, voidId: 8350 },
    { cc: 7078, keepId: 9414, voidId: 3756 },
    { cc: 7120, keepId: 9333, voidId: 8351 },
    { cc: 7372, keepId: 10183, voidId: 9686 },
    { cc: 7373, keepId: 9221, voidId: 3514 },
    { cc: 7563, keepId: 10144, voidId: 8345 },
    { cc: 7583, keepId: 9954, voidId: 7014 },
    { cc: 7584, keepId: 9964, voidId: 7028 },
    { cc: 7646, keepId: 10020, voidId: 5221 },
    { cc: 7655, keepId: 9245, voidId: 8347 },
    { cc: 7662, keepId: 9420, voidId: 5684 },
    { cc: 7729, keepId: 10250, voidId: 10247 },
    { cc: 7764, keepId: 10096, voidId: 9010 },
    { cc: 7765, keepId: 10056, voidId: 9011 },
];

const money = (n: number) => n.toLocaleString('en-PK', { maximumFractionDigits: 0 });

async function headOutstanding(voucherId: number) {
    // Non-discount heads of this voucher whose underlying fee still has a balance.
    const heads = await prisma.voucher_heads.findMany({
        where: { voucher_id: voucherId },
        select: {
            student_fee_id: true,
            student_fees: {
                select: { id: true, is_discount: true, amount: true, amount_paid: true, amount_before_discount: true },
            },
        },
    });
    const out = new Map<number, number>(); // student_fee_id -> outstanding
    for (const h of heads) {
        const sf = h.student_fees;
        if (!sf || sf.is_discount || h.student_fee_id == null) continue;
        const bal = Number(sf.amount ?? sf.amount_before_discount ?? 0) - Number(sf.amount_paid ?? 0);
        if (bal > 0.009) out.set(sf.id, bal);
    }
    return out;
}

async function keeperFeeIds(voucherId: number) {
    const heads = await prisma.voucher_heads.findMany({
        where: { voucher_id: voucherId },
        select: { student_fee_id: true },
    });
    return new Set(heads.map((h) => h.student_fee_id).filter((x): x is number => x != null));
}

async function main() {
    console.log(`\n=== Void multi-active older vouchers — ${COMMIT ? 'COMMIT' : 'DRY RUN'}${FORCE_ALL ? ' --force-all' : ''} ===\n`);

    type Row = {
        cc: number; keepId: number; voidId: number;
        voidStatus: string | null; voidNo: string | null; voidFee: string;
        keepStatus: string | null; keepNo: string | null; keepFee: string;
        uncovered: number; uncoveredHeads: number;
        classification: 'SAFE' | 'HELD' | 'SKIP';
        skipReason?: string;
    };
    const rows: Row[] = [];

    for (const t of TARGETS) {
        const [vv, kv] = await Promise.all([
            prisma.vouchers.findUnique({ where: { id: t.voidId }, select: { id: true, student_id: true, status: true, voucher_number: true, fee_date: true } }),
            prisma.vouchers.findUnique({ where: { id: t.keepId }, select: { id: true, student_id: true, status: true, voucher_number: true, fee_date: true } }),
        ]);

        const base: Row = {
            cc: t.cc, keepId: t.keepId, voidId: t.voidId,
            voidStatus: vv?.status ?? null, voidNo: vv?.voucher_number ?? null, voidFee: vv?.fee_date ? vv.fee_date.toISOString().slice(0, 10) : '—',
            keepStatus: kv?.status ?? null, keepNo: kv?.voucher_number ?? null, keepFee: kv?.fee_date ? kv.fee_date.toISOString().slice(0, 10) : '—',
            uncovered: 0, uncoveredHeads: 0, classification: 'SAFE',
        };

        if (!vv) { rows.push({ ...base, classification: 'SKIP', skipReason: 'void voucher not found' }); continue; }
        if (vv.student_id !== t.cc) { rows.push({ ...base, classification: 'SKIP', skipReason: `void voucher belongs to cc ${vv.student_id}` }); continue; }
        if (vv.status === 'VOID' || vv.status === 'PAID') { rows.push({ ...base, classification: 'SKIP', skipReason: `already ${vv.status}` }); continue; }
        if (!kv || kv.student_id !== t.cc) { rows.push({ ...base, classification: 'SKIP', skipReason: 'keeper voucher missing / wrong student' }); continue; }

        const out = await headOutstanding(t.voidId);
        const keeperFees = await keeperFeeIds(t.keepId);
        let uncovered = 0, uncoveredHeads = 0;
        for (const [fid, bal] of out) {
            if (!keeperFees.has(fid)) { uncovered += bal; uncoveredHeads++; }
        }
        rows.push({
            ...base,
            uncovered, uncoveredHeads,
            classification: uncovered > 0.009 ? 'HELD' : 'SAFE',
        });
    }

    for (const r of rows) {
        const tag = r.classification === 'SAFE' ? 'SAFE ' : r.classification === 'HELD' ? 'HELD ' : 'SKIP ';
        const extra =
            r.classification === 'HELD' ? `  uncovered ${money(r.uncovered)} across ${r.uncoveredHeads} head(s)` :
            r.classification === 'SKIP' ? `  (${r.skipReason})` : '';
        console.log(
            `${tag} cc ${String(r.cc).padEnd(5)} void #${String(r.voidId).padEnd(6)} ${(r.voidNo ?? '—').padEnd(12)} ${String(r.voidStatus).padEnd(15)} fee ${r.voidFee}` +
            `   keep #${String(r.keepId).padEnd(6)} ${String(r.keepStatus).padEnd(8)} fee ${r.keepFee}${extra}`,
        );
    }

    const toVoid = rows.filter((r) => r.classification === 'SAFE' || (FORCE_ALL && r.classification === 'HELD'));
    let done = 0;

    if (COMMIT) {
        for (const r of toVoid) {
            const note =
                `Backfill: student held >1 active voucher; voided older active voucher #${r.voidId} ` +
                `(no. ${r.voidNo ?? 'N/A'}, ${r.voidStatus}, fee ${r.voidFee}), kept newest #${r.keepId} ` +
                `(no. ${r.keepNo ?? 'N/A'}, fee ${r.keepFee}). ` +
                (r.uncovered > 0.009
                    ? `NOTE: ${money(r.uncovered)} of outstanding across ${r.uncoveredHeads} head(s) is NOT on the keeper — ` +
                      `student_fees rows keep their balance and will be swept onto the next generated voucher. `
                    : `Keeper already carries all outstanding heads. `) +
                `Cash on deposit_allocations left intact.`;
            await prisma.$transaction([
                prisma.vouchers.update({ where: { id: r.voidId }, data: { status: 'VOID' } }),
                prisma.audit_logs.create({
                    data: {
                        entity_type: 'VOUCHER', entity_id: String(r.voidId), action: 'UPDATED',
                        field: 'status', old_value: r.voidStatus, new_value: 'VOID',
                        changed_by: CHANGED_BY, student_id: r.cc, note,
                    },
                }),
            ]);
            done++;
        }
    }

    const held = rows.filter((r) => r.classification === 'HELD');
    const skip = rows.filter((r) => r.classification === 'SKIP');
    console.log(`\n--- ${COMMIT ? 'Done' : 'Dry run'} ---`);
    console.log(`SAFE            : ${rows.filter((r) => r.classification === 'SAFE').length}`);
    console.log(`HELD (uncovered): ${held.length}${held.length && !FORCE_ALL ? '  — not voided; re-run with --force-all to void anyway' : ''}`);
    console.log(`SKIP            : ${skip.length}`);
    console.log(`${COMMIT ? 'Voided' : 'Would void'}: ${COMMIT ? done : toVoid.length}`);
    if (!COMMIT) console.log(`\nRe-run with --commit (add --force-all to also void the HELD ones).`);
    console.log('');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
