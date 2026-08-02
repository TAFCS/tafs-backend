/**
 * Clean accidental duplicate MONTHLY TUITION FEE rows for 2026-2027.
 *
 * Only removes true accidental dupes (same student + month + fee_date + amount,
 * no split-payment prefixes, no live voucher heads).
 * Leaves PARTIAL/BALANCE split pairs alone.
 *
 *   npx ts-node scripts/clean-duplicate-mtf-2026-2027.ts
 *   npx ts-node scripts/clean-duplicate-mtf-2026-2027.ts --apply
 */

import { PrismaClient, fee_status_enum, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const ACADEMIC_YEAR = '2026-2027';
const MTF_FEE_TYPE_ID = 1;
const APPLY = process.argv.includes('--apply');

type Row = {
  id: number;
  student_id: number;
  target_month: number;
  fee_date: Date | null;
  amount: Prisma.Decimal | null;
  status: fee_status_enum | null;
  amount_paid: Prisma.Decimal | null;
  description_prefix: string | null;
  split_pair_id: number | null;
  campus_code: string;
  live_voucher_count: number;
};

function isSplitPayment(r: Row): boolean {
  const p = (r.description_prefix ?? '').toUpperCase();
  return (
    p.includes('PARTIAL') ||
    p.includes('BALANCE') ||
    r.split_pair_id != null
  );
}

function feeDateKey(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : 'null';
}

async function main() {
  console.log(
    APPLY
      ? 'MODE: APPLY (will delete accidental duplicates)\n'
      : 'MODE: DRY-RUN. Pass --apply to clean.\n',
  );

  const dupGroups = await prisma.$queryRaw<
    {
      student_id: number;
      target_month: number;
      cnt: bigint;
      campus_code: string;
    }[]
  >`
    SELECT
      sf.student_id,
      sf.target_month,
      COUNT(*)::bigint AS cnt,
      COALESCE(c.campus_code, 'UNKNOWN') AS campus_code
    FROM student_fees sf
    JOIN students s ON s.cc = sf.student_id
    LEFT JOIN campuses c ON c.id = s.campus_id
    WHERE sf.academic_year = ${ACADEMIC_YEAR}
      AND sf.fee_type_id = ${MTF_FEE_TYPE_ID}
      AND COALESCE(sf.is_discount, false) = false
      AND COALESCE(sf.is_arrear_surcharge, false) = false
    GROUP BY sf.student_id, sf.target_month, c.campus_code
    HAVING COUNT(*) > 1
    ORDER BY c.campus_code, sf.student_id, sf.target_month
  `;

  console.log(`Found ${dupGroups.length} month-group(s) with >1 MTF row.\n`);

  const studentIds = [...new Set(dupGroups.map((g) => Number(g.student_id)))];
  const allRows = await prisma.student_fees.findMany({
    where: {
      student_id: { in: studentIds },
      academic_year: ACADEMIC_YEAR,
      fee_type_id: MTF_FEE_TYPE_ID,
      is_discount: false,
      is_arrear_surcharge: false,
    },
    include: {
      students: { select: { campuses: { select: { campus_code: true } } } },
      voucher_heads: {
        select: {
          id: true,
          vouchers: { select: { status: true } },
        },
      },
    },
    orderBy: [{ student_id: 'asc' }, { target_month: 'asc' }, { id: 'asc' }],
  });

  const dupMonthSet = new Set(
    dupGroups.map((g) => `${g.student_id}:${g.target_month}`),
  );

  const grouped = new Map<string, Row[]>();
  for (const r of allRows) {
    const key = `${r.student_id}:${r.target_month}`;
    if (!dupMonthSet.has(key)) continue;
    const live = r.voucher_heads.filter(
      (vh) => vh.vouchers && !['VOID', 'EXPIRED'].includes(vh.vouchers.status ?? ''),
    ).length;
    const row: Row = {
      id: r.id,
      student_id: r.student_id,
      target_month: r.target_month,
      fee_date: r.fee_date,
      amount: r.amount,
      status: r.status,
      amount_paid: r.amount_paid,
      description_prefix: r.description_prefix,
      split_pair_id: r.split_pair_id,
      campus_code: r.students.campuses?.campus_code ?? 'UNKNOWN',
      live_voucher_count: live,
    };
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  const toDelete: number[] = [];
  const skippedSplit: string[] = [];
  const skippedOther: string[] = [];
  const cleaned: string[] = [];
  const byCampus: Record<string, { students: Set<number>; deleted: number }> = {};

  for (const [, rows] of grouped) {
    if (rows.length < 1) continue;

    // If any row looks like a split payment, leave the whole group alone
    if (rows.some(isSplitPayment)) {
      skippedSplit.push(
        `CC ${rows[0].student_id} [${rows[0].campus_code}] month=${rows[0].target_month} (split payment)`,
      );
      continue;
    }

    // Group further by fee_date + amount — only identical pairs are accidental dupes
    const byExact = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${feeDateKey(r.fee_date)}|${Number(r.amount)}`;
      if (!byExact.has(k)) byExact.set(k, []);
      byExact.get(k)!.push(r);
    }

    let deletedInGroup = 0;
    for (const [, exactRows] of byExact) {
      if (exactRows.length < 2) continue;

      // Prefer keep: has live vouchers > amount_paid > non-NOT_ISSUED > lowest id
      const ranked = [...exactRows].sort((a, b) => {
        if (a.live_voucher_count !== b.live_voucher_count) {
          return b.live_voucher_count - a.live_voucher_count;
        }
        const ap = Number(a.amount_paid ?? 0);
        const bp = Number(b.amount_paid ?? 0);
        if (ap !== bp) return bp - ap;
        if ((a.status === 'NOT_ISSUED') !== (b.status === 'NOT_ISSUED')) {
          return a.status === 'NOT_ISSUED' ? 1 : -1;
        }
        return a.id - b.id;
      });

      const keep = ranked[0];
      for (const d of ranked.slice(1)) {
        if (d.live_voucher_count > 0) {
          skippedOther.push(
            `CC ${d.student_id} month=${d.target_month} id=${d.id} (has live voucher)`,
          );
          continue;
        }
        toDelete.push(d.id);
        deletedInGroup += 1;
      }

      if (deletedInGroup > 0) {
        cleaned.push(
          `CC ${keep.student_id} [${keep.campus_code}] month=${keep.target_month}: keep ${keep.id}, delete ${ranked
            .slice(1)
            .filter((d) => toDelete.includes(d.id))
            .map((d) => d.id)
            .join(',')}`,
        );
        const code = keep.campus_code;
        if (!byCampus[code]) byCampus[code] = { students: new Set(), deleted: 0 };
        byCampus[code].students.add(keep.student_id);
        byCampus[code].deleted += ranked.slice(1).filter((d) => toDelete.includes(d.id)).length;
      }
    }

    if (deletedInGroup === 0 && !rows.some(isSplitPayment)) {
      // Different amounts/dates under same target_month — not identical dupes
      skippedOther.push(
        `CC ${rows[0].student_id} [${rows[0].campus_code}] month=${rows[0].target_month} (not identical amount/date)`,
      );
    }
  }

  console.log('=== ACCIDENTAL DUPES TO CLEAN ===');
  for (const [code, s] of Object.entries(byCampus).sort()) {
    console.log(
      `  ${code}: ${s.students.size} student(s), ${s.deleted} row(s)`,
    );
  }
  console.log(`\nTotal rows to delete: ${toDelete.length}`);
  console.log(cleaned.slice(0, 30).join('\n') || '  (none)');
  if (cleaned.length > 30) console.log(`  ... +${cleaned.length - 30} more`);

  console.log(`\n=== SKIPPED (split payments): ${skippedSplit.length} ===`);
  for (const s of skippedSplit) console.log(`  ${s}`);

  if (skippedOther.length) {
    console.log(`\n=== SKIPPED (other): ${skippedOther.length} ===`);
    for (const s of skippedOther.slice(0, 20)) console.log(`  ${s}`);
  }

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with --apply to delete.');
    return;
  }

  if (toDelete.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  const res = await prisma.student_fees.deleteMany({
    where: { id: { in: toDelete } },
  });
  console.log(`\nDeleted ${res.count} row(s).`);

  // Verify CC 8036 and remaining identical dupes
  const remaining = await prisma.$queryRaw<{ cnt: bigint }[]>`
    SELECT COUNT(*)::bigint AS cnt FROM (
      SELECT student_id, target_month, fee_date, amount
      FROM student_fees
      WHERE academic_year = ${ACADEMIC_YEAR}
        AND fee_type_id = ${MTF_FEE_TYPE_ID}
        AND COALESCE(is_discount, false) = false
        AND COALESCE(is_arrear_surcharge, false) = false
        AND description_prefix IS NULL
        AND split_pair_id IS NULL
      GROUP BY student_id, target_month, fee_date, amount
      HAVING COUNT(*) > 1
    ) t
  `;
  console.log(
    `Remaining identical accidental duplicate groups: ${Number(remaining[0]?.cnt ?? 0)}`,
  );

  const nnz8036 = await prisma.student_fees.count({
    where: {
      student_id: 8036,
      academic_year: ACADEMIC_YEAR,
      fee_type_id: MTF_FEE_TYPE_ID,
    },
  });
  console.log(`CC 8036 MTF rows now: ${nnz8036} (expect 12)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
