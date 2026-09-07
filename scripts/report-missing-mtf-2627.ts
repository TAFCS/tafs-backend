/**
 * Report: 2026-2027 fee-head coverage vs. endowment / complimentary flags.
 *
 * Buckets (see `bucket` column):
 *   NO_HEADS            - student has ZERO student_fees rows for academic_year 2026-2027 (any fee_type)
 *   HEADS_NO_MTF        - student has >=1 head for 2026-2027 but NONE with fee_type_id = 1 (MONTHLY TUITION FEE)
 *   FLAGGED_WITH_HEADS  - student is marked fee-endowment and/or complimentary AND has >=1 head for 2026-2027
 *
 * A student can only land in one bucket; priority is NO_HEADS -> HEADS_NO_MTF -> FLAGGED_WITH_HEADS.
 * `fee_flag` column: FE / COMP / FE+COMP / NONE  (FE = is_fee_endowment, COMP = is_complementary)
 *
 * Output: report-missing-mtf-2627.csv in repo root.
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const ACADEMIC_YEAR = '2026-2027';
const MTF_FEE_TYPE_ID = 1;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const students = await prisma.students.findMany({
    where: { deleted_at: null, status: 'ENROLLED' },
    select: {
      cc: true,
      gr_number: true,
      full_name: true,
      status: true,
      class_id: true,
      is_fee_endowment: true,
      is_complementary: true,
      fee_endowment_reason: true,
      fee_endowment_until: true,
      complementary_reason: true,
      complementary_until: true,
      classes: { select: { description: true } },
      sections: { select: { description: true } },
      campuses: { select: { campus_name: true } },
    },
    orderBy: [{ campus_id: 'asc' }, { class_id: 'asc' }, { cc: 'asc' }],
  });

  // fee heads for 2026-2027, grouped per student
  const heads = await prisma.student_fees.groupBy({
    by: ['student_id', 'fee_type_id'],
    where: { academic_year: ACADEMIC_YEAR },
    _count: { _all: true },
  });

  const totalHeadsByStudent = new Map<number, number>();
  const mtfHeadsByStudent = new Map<number, number>();
  for (const h of heads) {
    totalHeadsByStudent.set(
      h.student_id,
      (totalHeadsByStudent.get(h.student_id) ?? 0) + h._count._all,
    );
    if (h.fee_type_id === MTF_FEE_TYPE_ID) {
      mtfHeadsByStudent.set(
        h.student_id,
        (mtfHeadsByStudent.get(h.student_id) ?? 0) + h._count._all,
      );
    }
  }

  const rows: Record<string, string | number>[] = [];
  const counts = { NO_HEADS: 0, HEADS_NO_MTF: 0, FLAGGED_WITH_HEADS: 0 };

  for (const s of students) {
    const totalHeads = totalHeadsByStudent.get(s.cc) ?? 0;
    const mtfHeads = mtfHeadsByStudent.get(s.cc) ?? 0;
    const fe = s.is_fee_endowment;
    const comp = s.is_complementary;
    const feeFlag = fe && comp ? 'FE+COMP' : fe ? 'FE' : comp ? 'COMP' : 'NONE';

    let bucket: keyof typeof counts | null = null;
    if (totalHeads === 0) bucket = 'NO_HEADS';
    else if (mtfHeads === 0) bucket = 'HEADS_NO_MTF';
    else if (fe || comp) bucket = 'FLAGGED_WITH_HEADS';

    if (!bucket) continue;
    counts[bucket]++;

    rows.push({
      bucket,
      cc: s.cc,
      gr_number: s.gr_number ?? '',
      full_name: s.full_name,
      status: s.status,
      campus: s.campuses?.campus_name ?? '',
      class: s.classes?.description ?? '',
      section: s.sections?.description ?? 'Unassigned',
      heads_2026_2027: totalHeads,
      mtf_heads_2026_2027: mtfHeads,
      fee_flag: feeFlag,
      is_fee_endowment: fe ? 'YES' : 'NO',
      is_complimentary: comp ? 'YES' : 'NO',
      fee_endowment_reason: s.fee_endowment_reason ?? '',
      fee_endowment_until: s.fee_endowment_until
        ? s.fee_endowment_until.toISOString().slice(0, 10)
        : '',
      complimentary_reason: s.complementary_reason ?? '',
      complimentary_until: s.complementary_until
        ? s.complementary_until.toISOString().slice(0, 10)
        : '',
    });
  }

  const headers = [
    'bucket',
    'cc',
    'gr_number',
    'full_name',
    'status',
    'campus',
    'class',
    'section',
    'heads_2026_2027',
    'mtf_heads_2026_2027',
    'fee_flag',
    'is_fee_endowment',
    'is_complimentary',
    'fee_endowment_reason',
    'fee_endowment_until',
    'complimentary_reason',
    'complimentary_until',
  ];

  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')),
  ].join('\n');

  const outPath = path.resolve(__dirname, '..', 'report-missing-mtf-2627.csv');
  fs.writeFileSync(outPath, csv + '\n');

  console.log(`Academic year: ${ACADEMIC_YEAR}`);
  console.log(`Students scanned (ENROLLED, not deleted): ${students.length}`);
  console.log('--- bucket counts ---');
  console.log(`NO_HEADS (no fee head at all for ${ACADEMIC_YEAR}):        ${counts.NO_HEADS}`);
  console.log(`HEADS_NO_MTF (has heads but no fee_type_id=1):             ${counts.HEADS_NO_MTF}`);
  console.log(`FLAGGED_WITH_HEADS (FE/COMP marked but has heads in year): ${counts.FLAGGED_WITH_HEADS}`);
  console.log(`Total rows written: ${rows.length}`);
  console.log(`\nCSV: ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
