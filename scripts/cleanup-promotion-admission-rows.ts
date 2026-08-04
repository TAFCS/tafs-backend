/**
 * Remove legacy student_admissions rows that were created by the old promote
 * path (before promotions stopped writing application history).
 *
 * Keeps the earliest admission per student always. Candidate rows must:
 *   - not be is_readmission
 *   - have no transfer_order_url
 *   - and either:
 *       a) academic_year matches a PROMOTED progression period for that student, OR
 *       b) requested_grade is set (old promote wrote class description) AND the student
 *          has no TRANSFER audit and no TRANSFERRED progression
 *
 * Usage:
 *   npx ts-node scripts/cleanup-promotion-admission-rows.ts              # dry-run
 *   APPLY=true npx ts-node scripts/cleanup-promotion-admission-rows.ts   # delete
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const apply = process.env.APPLY === 'true';
  const dryRun = !apply;

  console.log(
    dryRun
      ? 'DRY RUN — no deletions will be performed (set APPLY=true to delete)'
      : 'APPLY MODE — matching promotion admission rows will be deleted',
  );

  const multiCounts = await prisma.student_admissions.groupBy({
    by: ['student_id'],
    _count: { _all: true },
  });
  const studentIds = multiCounts
    .filter((s) => s._count._all > 1)
    .map((s) => s.student_id);
  console.log(`Students with multiple admissions: ${studentIds.length}`);

  if (studentIds.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const admissions = await prisma.student_admissions.findMany({
    where: { student_id: { in: studentIds } },
    orderBy: [{ student_id: 'asc' }, { application_date: 'asc' }, { id: 'asc' }],
  });

  const byStudent = new Map<number, typeof admissions>();
  for (const a of admissions) {
    const list = byStudent.get(a.student_id) ?? [];
    list.push(a);
    byStudent.set(a.student_id, list);
  }

  const progression = await prisma.student_progression_periods.findMany({
    where: {
      student_cc: { in: studentIds },
      change_type: { in: ['PROMOTED', 'TRANSFERRED'] },
    },
    select: { student_cc: true, academic_year: true, change_type: true },
  });

  const promotedYearSet = new Map<number, Set<string>>();
  const transferStudentSet = new Set<number>();
  for (const p of progression) {
    if (p.change_type === 'TRANSFERRED') {
      transferStudentSet.add(p.student_cc);
    }
    if (p.change_type === 'PROMOTED' && p.academic_year) {
      const set = promotedYearSet.get(p.student_cc) ?? new Set<string>();
      set.add(p.academic_year);
      promotedYearSet.set(p.student_cc, set);
    }
  }

  // Transfer audit evidence
  const transferAudits = await prisma.audit_logs.findMany({
    where: {
      OR: [
        { student_id: { in: studentIds }, entity_type: 'TRANSFER' },
        { entity_id: { in: studentIds.map(String) }, entity_type: 'TRANSFER' },
      ],
    },
    select: { student_id: true, entity_id: true },
  });
  for (const a of transferAudits) {
    if (a.student_id != null) transferStudentSet.add(a.student_id);
    const asNum = a.entity_id != null ? Number(a.entity_id) : NaN;
    if (!Number.isNaN(asNum)) transferStudentSet.add(asNum);
  }

  const toDelete: {
    id: number;
    student_id: number;
    academic_year: string | null;
    application_date: Date | null;
    reason: string;
  }[] = [];

  for (const [studentId, rows] of byStudent) {
    if (rows.length <= 1) continue;
    const [, ...rest] = rows;
    const years = promotedYearSet.get(studentId) ?? new Set();
    const hasTransferEvidence =
      transferStudentSet.has(studentId) ||
      rows.some((r) => !!r.transfer_order_url);

    for (const row of rest) {
      if (row.is_readmission) continue;
      if (row.transfer_order_url) continue;

      if (row.academic_year && years.has(row.academic_year)) {
        toDelete.push({
          id: row.id,
          student_id: row.student_id,
          academic_year: row.academic_year,
          application_date: row.application_date,
          reason: 'promoted_year_match',
        });
        continue;
      }

      const grade = (row.requested_grade ?? '').toString().trim();
      if (grade && !hasTransferEvidence) {
        toDelete.push({
          id: row.id,
          student_id: row.student_id,
          academic_year: row.academic_year,
          application_date: row.application_date,
          reason: 'promote_like_grade_no_transfer',
        });
      }
    }
  }

  console.log(`Promotion-style admission rows to remove: ${toDelete.length}`);
  for (const row of toDelete.slice(0, 50)) {
    console.log(
      `  id=${row.id} student=${row.student_id} year=${row.academic_year ?? 'n/a'} date=${row.application_date?.toISOString() ?? 'n/a'} reason=${row.reason}`,
    );
  }
  if (toDelete.length > 50) {
    console.log(`  ... and ${toDelete.length - 50} more`);
  }

  if (dryRun) {
    console.log('Dry run complete. Re-run with APPLY=true to delete.');
    return;
  }

  if (toDelete.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  const ids = toDelete.map((r) => r.id);
  const result = await prisma.student_admissions.deleteMany({
    where: { id: { in: ids } },
  });
  console.log(`Deleted ${result.count} admission row(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
