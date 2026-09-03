/**
 * Set leaving_time = 14:20 for all non-O/A-Level teachers on FIXED check-in.
 *
 * "Teacher" = job_title looks teacherish (teacher / faculty / coach / scout leader /
 * montessori / tutor / instructor / lecturer) OR staff_category sits in dep code "02"
 * (TEACHER / ASSISTANT_TEACHER / SPORTS_COACH / SCOUT_LEADER).
 *
 * Excluded:
 *   - O-Level / A-Level teachers (job_title mentions O/A LEVEL, segment 4/5, or a
 *     class link to O-I/O-II/O-III/AS/A2)
 *   - check_in_source = TIMETABLE (leaving_time is derived, not stored)
 *   - the QA test fixture TEST-HASHIR-001
 *
 * Scope: employment_status in (ACTIVE, PERMANENT). Only rows whose leaving_time
 * is not already 14:20 are written.
 *
 * Run:  npx ts-node scripts/set-teacher-leaving-time-1420.ts          (dry run)
 *       npx ts-node scripts/set-teacher-leaving-time-1420.ts --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const OA_CLASS_IDS = [12, 13, 14, 20, 21];
const OA_SEGMENT_IDS = [4, 5];
const EXCLUDE_IDS = new Set<number>([184]); // TEST-HASHIR-001
const TARGET_HHMM = '14:20';
const TARGET = new Date(`1970-01-01T${TARGET_HHMM}:00Z`);

const hhmm = (d: Date | null) => (d ? new Date(d).toISOString().slice(11, 16) : null);

async function main() {
  const oaViaClass = new Set<number>();
  for (const a of await prisma.employee_class_section_assignments.findMany({ where: { class_id: { in: OA_CLASS_IDS } }, select: { employee_id: true } })) oaViaClass.add(a.employee_id);
  for (const g of await prisma.teaching_groups.findMany({ where: { class_id: { in: OA_CLASS_IDS } }, select: { employee_id: true } })) oaViaClass.add(g.employee_id);
  for (const s of await prisma.timetable_slots.findMany({ where: { timetables: { class_id: { in: OA_CLASS_IDS } } }, select: { employee_id: true } })) oaViaClass.add(s.employee_id);

  const emps = await prisma.employee_profiles.findMany({
    where: { employment_status: { in: ['ACTIVE', 'PERMANENT'] } },
    select: {
      id: true, full_name: true, employee_code: true, job_title: true, segment_id: true,
      check_in_source: true, reporting_time: true, leaving_time: true,
      staff_categories: { select: { name: true, employee_code_dep: true } },
    },
    orderBy: { id: 'asc' },
  });

  const isOA = (e: (typeof emps)[number]) => {
    const t = (e.job_title ?? '').toUpperCase();
    if (/\bO[\s-]?LEVEL\b/.test(t) || /\bA[\s-]?LEVEL\b/.test(t)) return true;
    if (e.segment_id != null && OA_SEGMENT_IDS.includes(e.segment_id)) return true;
    if (oaViaClass.has(e.id)) return true;
    return false;
  };
  const isTeacher = (e: (typeof emps)[number]) =>
    /teacher|faculty|coach|scout leader|montessori|tutor|instructor|lecturer/i.test(e.job_title ?? '') ||
    e.staff_categories?.employee_code_dep === '02';

  const targets = emps.filter(
    (e) => isTeacher(e) && !isOA(e) && !EXCLUDE_IDS.has(e.id) && e.check_in_source === 'FIXED',
  );

  const alreadyOk = targets.filter((e) => hhmm(e.leaving_time) === TARGET_HHMM);
  const toChange = targets.filter((e) => hhmm(e.leaving_time) !== TARGET_HHMM);

  const row = (e: (typeof emps)[number]) => ({
    id: e.id, code: e.employee_code, name: e.full_name, title: e.job_title,
    in: hhmm(e.reporting_time), out_now: hhmm(e.leaving_time), out_new: TARGET_HHMM,
  });

  console.log(`non-O/A FIXED teachers: ${targets.length} | already ${TARGET_HHMM}: ${alreadyOk.length} | will change: ${toChange.length}\n`);
  console.log('### WILL CHANGE');
  console.table(toChange.map(row));
  const odd = toChange.filter((e) => {
    const c = hhmm(e.leaving_time);
    return c !== '02:30' && c !== '02:20' && c !== '14:30' && c !== null;
  });
  if (odd.length) {
    console.log('### ⚠  non-2:30-style current values among the above — double-check these:');
    console.table(odd.map(row));
  }

  if (!APPLY) {
    console.log('\nDRY RUN — no writes. Re-run with --apply to commit.');
    return;
  }

  const fs = await import('fs');
  const backup = 'scripts/set-teacher-leaving-time-1420.backup.csv';
  fs.writeFileSync(
    backup,
    'id,employee_code,name,prev_leaving_time\n' +
      toChange.map((e) => `${e.id},${e.employee_code ?? ''},"${e.full_name ?? ''}",${hhmm(e.leaving_time) ?? ''}`).join('\n') + '\n',
  );
  console.log(`\nPrev values backed up to ${backup}`);

  let n = 0;
  for (const e of toChange) {
    await prisma.employee_profiles.update({ where: { id: e.id }, data: { leaving_time: TARGET } });
    n++;
  }
  console.log(`APPLIED — ${n} rows updated to leaving_time = ${TARGET_HHMM}.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
