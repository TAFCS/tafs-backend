/**
 * Set late_relaxation_minutes = 5 for all working employees.
 *
 * Exceptions (left untouched):
 *   - S. JOHN HASSAN RIZVI  (employee id 163)
 *   - Every O-Level / A-Level teacher, identified by ANY of:
 *       • job_title mentions "O LEVEL" / "A LEVEL" (with or without hyphen)
 *       • segment_id in (4 = O-Levels Cambridge, 5 = A-Levels Cambridge)
 *       • assigned to class O-I / O-II / O-III / AS / A2 via
 *         class-section assignment, teaching group, or timetable slot
 *
 * Scope: employment_status in (ACTIVE, PERMANENT).
 *
 * Run:  npx ts-node scripts/set-late-relaxation-5min.ts          (dry run)
 *       npx ts-node scripts/set-late-relaxation-5min.ts --apply  (writes)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const JOHN_ID = 163;
// Extra manual exclusions requested by HR:
//   212 = KANEEZ -E- UMMAY FERWA (Campus Head, BUI NNN)
const EXTRA_EXCLUDE_IDS = new Set<number>([212]);
const OA_CLASS_IDS = [12, 13, 14, 20, 21]; // O-I, O-II, O-III, AS, A2
const OA_SEGMENT_IDS = [4, 5];
const TARGET = 5;

async function main() {
  const employees = await prisma.employee_profiles.findMany({
    where: { employment_status: { in: ['ACTIVE', 'PERMANENT'] } },
    select: {
      id: true, full_name: true, employee_code: true, job_title: true,
      segment_id: true, employment_status: true, late_relaxation_minutes: true,
    },
    orderBy: { id: 'asc' },
  });

  const oaViaClass = new Set<number>();
  for (const a of await prisma.employee_class_section_assignments.findMany({
    where: { class_id: { in: OA_CLASS_IDS } }, select: { employee_id: true },
  })) oaViaClass.add(a.employee_id);
  for (const g of await prisma.teaching_groups.findMany({
    where: { class_id: { in: OA_CLASS_IDS } }, select: { employee_id: true },
  })) oaViaClass.add(g.employee_id);
  for (const s of await prisma.timetable_slots.findMany({
    where: { timetables: { class_id: { in: OA_CLASS_IDS } } }, select: { employee_id: true },
  })) oaViaClass.add(s.employee_id);

  const isOATeacher = (e: (typeof employees)[number]) => {
    const t = (e.job_title ?? '').toUpperCase();
    if (/\bO[\s-]?LEVEL\b/.test(t) || /\bA[\s-]?LEVEL\b/.test(t)) return true;
    if (e.segment_id != null && OA_SEGMENT_IDS.includes(e.segment_id)) return true;
    if (oaViaClass.has(e.id)) return true;
    return false;
  };

  const toChange: typeof employees = [];
  const excludedJohn: typeof employees = [];
  const excludedManual: typeof employees = [];
  const excludedOA: typeof employees = [];
  const alreadyOk: typeof employees = [];

  for (const e of employees) {
    if (e.id === JOHN_ID) { excludedJohn.push(e); continue; }
    if (EXTRA_EXCLUDE_IDS.has(e.id)) { excludedManual.push(e); continue; }
    if (isOATeacher(e)) { excludedOA.push(e); continue; }
    if (e.late_relaxation_minutes === TARGET) { alreadyOk.push(e); continue; }
    toChange.push(e);
  }

  const row = (e: (typeof employees)[number]) => ({
    id: e.id, code: e.employee_code, name: e.full_name,
    title: e.job_title, seg: e.segment_id, from: e.late_relaxation_minutes,
  });

  console.log(`\n### EXCLUDED — John Rizvi (${excludedJohn.length})`);
  console.table(excludedJohn.map(row));
  console.log(`\n### EXCLUDED — manual (${excludedManual.length})`);
  console.table(excludedManual.map(row));
  console.log(`\n### EXCLUDED — O/A-Level teachers (${excludedOA.length})`);
  console.table(excludedOA.map(row));
  console.log(`\n### NO CHANGE — already at ${TARGET} (${alreadyOk.length})`);
  console.log(`\n### WILL SET to ${TARGET} (${toChange.length})`);
  console.table(toChange.map(row));

  if (!APPLY) {
    console.log('\nDRY RUN — no writes. Re-run with --apply to commit.');
    return;
  }

  const ids = toChange.map((e) => e.id);
  const fs = await import('fs');
  const backup = 'scripts/set-late-relaxation-5min.backup.csv';
  fs.writeFileSync(
    backup,
    'id,employee_code,name,prev_late_relaxation_minutes\n' +
      toChange.map((e) => `${e.id},${e.employee_code ?? ''},"${e.full_name ?? ''}",${e.late_relaxation_minutes ?? ''}`).join('\n') + '\n',
  );
  console.log(`\nPrev values backed up to ${backup}`);
  const res = await prisma.employee_profiles.updateMany({
    where: { id: { in: ids } },
    data: { late_relaxation_minutes: TARGET },
  });
  console.log(`APPLIED — ${res.count} rows updated to late_relaxation_minutes = ${TARGET}.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
