/**
 * The gate for the Defaulters report.
 *
 * The report's whole claim is that it mirrors VouchersService.computeArrears
 * (vouchers.service.ts:5214) exactly — so that months_behind IS the number of
 * Rs 1000 late payment surcharges the next voucher would carry, and the report
 * can never disagree with what the system actually bills.
 *
 * This asserts that claim against real data, per student:
 *   computeArrears(cc, asOf).surcharge_groups.length === months_behind
 *   computeArrears(cc, asOf).total_arrears        === arrears_outstanding
 *
 * Run: npx ts-node scripts/verify-defaulters-vs-compute-arrears.ts [YYYY-MM-DD] [sampleSize]
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/** Verbatim port of VouchersService.computeArrears' counting, as the oracle. */
async function computeArrearsOracle(studentId: number, targetFeeDate: Date) {
  const candidates = await prisma.student_fees.findMany({
    where: {
      student_id: studentId,
      fee_date: { lt: targetFeeDate },
      status: { notIn: ['PAID', 'DISCOUNT'] },
      is_arrear_surcharge: false,
      is_discount: false,
    },
    orderBy: { fee_date: 'asc' },
  });

  let totalArrears = new Prisma.Decimal(0);
  const distinctGroups = new Map<string, true>();

  for (const fee of candidates) {
    const amount = new Prisma.Decimal(fee.amount ?? fee.amount_before_discount ?? 0);
    const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
    const outstanding = amount.sub(paid);
    if (outstanding.lte(0)) continue;

    totalArrears = totalArrears.add(outstanding);
    const groupKey = `${fee.academic_year}_${fee.target_month}`;
    if (fee.academic_year && fee.target_month != null && !distinctGroups.has(groupKey)) {
      distinctGroups.set(groupKey, true);
    }
  }
  return {
    surcharge_group_count: distinctGroups.size,
    total_arrears: Number(totalArrears.toFixed(2)),
  };
}

/** The report's CTE, verbatim. */
async function reportAggregates(ids: number[], asOfDate: string) {
  if (ids.length === 0) return [];
  return prisma.$queryRaw<
    Array<{
      student_id: number;
      months_behind: number;
      arrears_outstanding: number | null;
      arrear_head_count: number;
    }>
  >(Prisma.sql`
    WITH candidates AS (
        SELECT sf.student_id,
               NULLIF(btrim(sf.academic_year), '') AS academic_year,
               sf.target_month, sf.fee_date, sf.status,
               COALESCE(sf.amount, sf.amount_before_discount, 0)
                 - COALESCE(sf.amount_paid, 0) AS outstanding
        FROM public.student_fees sf
        WHERE sf.student_id IN (${Prisma.join(ids)})
          AND sf.fee_date IS NOT NULL
          AND sf.fee_date < ${asOfDate}::date
          AND sf.is_arrear_surcharge = false
          AND sf.is_discount = false
          AND sf.status <> 'PAID'
          AND sf.status <> 'DISCOUNT'
          AND COALESCE(sf.amount, sf.amount_before_discount, 0)
                - COALESCE(sf.amount_paid, 0) > 0
    ),
    money AS (
        SELECT student_id, SUM(outstanding)::float8 AS arrears_outstanding,
               COUNT(*)::int AS arrear_head_count
        FROM candidates GROUP BY student_id
    ),
    groups AS (
        SELECT student_id, academic_year, target_month
        FROM candidates
        WHERE academic_year IS NOT NULL AND target_month IS NOT NULL
        GROUP BY student_id, academic_year, target_month
    ),
    per_student AS (
        SELECT student_id, COUNT(*)::int AS months_behind
        FROM groups GROUP BY student_id
    )
    SELECT m.student_id, COALESCE(p.months_behind, 0) AS months_behind,
           m.arrears_outstanding, m.arrear_head_count
    FROM money m LEFT JOIN per_student p ON p.student_id = m.student_id
    WHERE COALESCE(p.months_behind, 0) >= 1
  `);
}

async function main() {
  const asOfDate = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const sampleSize = Number(process.argv[3] ?? 40);
  const targetFeeDate = (() => {
    const [y, m, d] = asOfDate.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  })();

  console.log(`as_of_date = ${asOfDate} (exclusive)\n`);

  // NULL-status check — status is nullable, and `status <> 'PAID'` evaluates to
  // NULL and DROPS those rows (same as Prisma's notIn, which the engine uses).
  const [{ n: nullStatus }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n FROM public.student_fees WHERE status IS NULL`;
  console.log(`student_fees with NULL status: ${nullStatus}`);
  if (Number(nullStatus) > 0) {
    console.log('  ^ these are dropped by BOTH the engine and the report (consistent), but worth a decision.');
  }

  const students = await prisma.students.findMany({
    where: { deleted_at: null },
    select: { cc: true },
  });
  const allIds = students.map((s) => s.cc);
  console.log(`students in scope: ${allIds.length}`);

  const t0 = Date.now();
  const rows = await reportAggregates(allIds, asOfDate);
  const ms = Date.now() - t0;
  console.log(`report CTE: ${rows.length} defaulters in ${ms}ms\n`);

  const bands = { 1: 0, 2: 0, 3: 0, '4+': 0 } as Record<string, number>;
  for (const r of rows) {
    const k = r.months_behind >= 4 ? '4+' : String(r.months_behind);
    bands[k] = (bands[k] ?? 0) + 1;
  }
  console.log('months behind:', bands, '\n');

  // Sample the worst offenders plus a random spread — bugs hide in both.
  const sorted = [...rows].sort((a, b) => b.months_behind - a.months_behind);
  const sample = [
    ...sorted.slice(0, Math.ceil(sampleSize / 2)),
    ...[...rows].sort(() => Math.random() - 0.5).slice(0, Math.floor(sampleSize / 2)),
  ];
  const seen = new Set<number>();

  let checked = 0;
  let monthMismatch = 0;
  let moneyMismatch = 0;

  for (const row of sample) {
    if (seen.has(row.student_id)) continue;
    seen.add(row.student_id);
    checked += 1;

    const oracle = await computeArrearsOracle(row.student_id, targetFeeDate);
    const reportMoney = Math.round((row.arrears_outstanding ?? 0) * 100) / 100;

    if (oracle.surcharge_group_count !== row.months_behind) {
      monthMismatch += 1;
      console.log(
        `MONTHS MISMATCH cc=${row.student_id}: engine=${oracle.surcharge_group_count} report=${row.months_behind}`,
      );
    }
    if (Math.abs(oracle.total_arrears - reportMoney) > 0.01) {
      moneyMismatch += 1;
      console.log(
        `MONEY MISMATCH  cc=${row.student_id}: engine=${oracle.total_arrears} report=${reportMoney}`,
      );
    }
  }

  console.log(`\nchecked ${checked} students`);
  console.log(`  months_behind mismatches:       ${monthMismatch}`);
  console.log(`  arrears_outstanding mismatches: ${moneyMismatch}`);
  console.log(
    monthMismatch === 0 && moneyMismatch === 0
      ? '\nPASS — the report mirrors computeArrears.'
      : '\nFAIL — the report does NOT mirror computeArrears. Do not ship.',
  );
  process.exitCode = monthMismatch === 0 && moneyMismatch === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
