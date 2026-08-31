/**
 * backfill-employee-segments.ts
 *
 * Set employee_profiles.segment_id for ACADEMICS staff where it is null.
 * Derivation order:
 *   1. Dominant segment from employee_class_section_assignments (by pair count)
 *   2. Dominant segment from teaching_groups (2026-2027)
 *   3. Job-title heuristics (O/A-Level faculty, Early Years, etc.)
 *
 * Usage:
 *   npx ts-node scripts/backfill-employee-segments.ts
 *   DRY_RUN=false npx ts-node scripts/backfill-employee-segments.ts
 */

import { PrismaClient } from '@prisma/client';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const ACADEMIC_YEAR = '2026-2027';
const prisma = new PrismaClient();

function segmentFromJobTitle(jobTitle: string | null | undefined): number | null {
  const t = (jobTitle ?? '').toUpperCase();
  if (!t) return null;
  if (/\bA[\s-]?LEVEL\b|\bTAFSAL\b/.test(t)) return 5;
  if (/\bO[\s-]?LEVEL\b|\bO[\s-]?I\b|\bO[\s-]?II\b|\bO[\s-]?III\b/.test(t)) return 4;
  if (/\bSECONDARY\b|\bCLASS VI\b|\bGYM\b|\bBAND\b/.test(t)) return 6;
  if (/\bSENIOR\b|\bSR[\.\s-]?I\b/.test(t) && !/\bJUNIOR\b/.test(t)) return 3;
  if (/\bJUNIORS?\b|\bJRI\b|\bJR[\.\s]/i.test(t)) return 2;
  if (/\bEARLY YEAR\b|\bPRE[\s-]?PRIMARY\b|\bHOME TEACHER KG\b|\bNURSERY\b|\bKG\b/.test(t)) return 1;
  return null;
}

function dominantSegment(counts: Map<number, number>): number | null {
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN (no writes) ===\n' : '=== BACKFILL EMPLOYEE SEGMENTS ===\n');

  const segmentNames = new Map(
    (await prisma.segments.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]),
  );

  const employees = await prisma.employee_profiles.findMany({
    where: {
      departments: { name: 'ACADEMICS' },
      segment_id: null,
      employment_status: 'ACTIVE',
    },
    select: {
      id: true,
      employee_code: true,
      full_name: true,
      job_title: true,
      employee_class_section_assignments: {
        select: { classes: { select: { segment_id: true } } },
      },
      teaching_groups: {
        where: { academic_year: ACADEMIC_YEAR, is_active: true },
        select: { classes: { select: { segment_id: true } } },
      },
    },
    orderBy: { full_name: 'asc' },
  });

  let updated = 0;
  let skipped = 0;

  for (const emp of employees) {
    const counts = new Map<number, number>();
    for (const a of emp.employee_class_section_assignments) {
      const sid = a.classes?.segment_id;
      if (sid) counts.set(sid, (counts.get(sid) ?? 0) + 1);
    }
    for (const g of emp.teaching_groups) {
      const sid = g.classes?.segment_id;
      if (sid) counts.set(sid, (counts.get(sid) ?? 0) + 1);
    }

    let segmentId = dominantSegment(counts);
    let source = segmentId ? 'assignments/groups' : '';

    if (!segmentId) {
      segmentId = segmentFromJobTitle(emp.job_title);
      if (segmentId) source = 'job_title';
    }

    if (!segmentId) {
      console.log(`  [SKIP] ${emp.employee_code} — ${emp.full_name} (${emp.job_title ?? 'no title'})`);
      skipped++;
      continue;
    }

    const segName = segmentNames.get(segmentId) ?? `#${segmentId}`;
    console.log(`  [${DRY_RUN ? 'DRY' : 'SET'}] ${emp.employee_code} — ${emp.full_name} → ${segName} (${source})`);

    if (!DRY_RUN) {
      await prisma.employee_profiles.update({
        where: { id: emp.id },
        data: { segment_id: segmentId },
      });
    }
    updated++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`  Candidates: ${employees.length}`);
  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}`);
  console.log(`  Skipped (no signal): ${skipped}`);
  if (DRY_RUN) console.log('\nRun with DRY_RUN=false to apply.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
