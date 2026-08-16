/**
 * Read-only integrity audit of biometric scan attribution.
 *
 * `device_user_mappings` is meant to be the source of truth for who a
 * (device_sn, device_pin) belongs to, but `zk_attendance_scans` denormalizes
 * that identity at ingest and nothing re-derives it. This script reports where
 * the two have drifted apart, plus the related data-quality hazards.
 *
 * Writes nothing. Emits a CSV per report next to the repo.
 *
 * Usage: npx ts-node scripts/audit-zk-scan-attribution.ts
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();
const OUT_DIR = join(__dirname, '../..');

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(name: string, rows: Record<string, unknown>[]): string | null {
  if (rows.length === 0) return null;
  const header = Object.keys(rows[0]);
  const body = rows.map((r) => header.map((h) => csvEscape(r[h])).join(','));
  const path = join(OUT_DIR, name);
  writeFileSync(path, [header.join(','), ...body].join('\n') + '\n');
  return path;
}

async function main() {
  const written: string[] = [];

  // ── A. DRIFT — denormalized person != what the current mapping says ────────
  // MANUAL scans are gate-desk punches with no mapping by design (MANUAL_DEVICE_SN),
  // so they'd otherwise flood this as false orphans.
  const drift = await prisma.$queryRaw<any[]>`
    SELECT s.id AS scan_id, s.device_sn, s.device_pin, s.attendance_date::text AS attendance_date,
           s.person_type::text AS cur_type, s.employee_id AS cur_employee_id, s.student_cc AS cur_student_cc,
           (CASE WHEN m.is_active THEN m.person_type::text END) AS want_type,
           (CASE WHEN m.is_active AND m.person_type = 'STAFF'   THEN m.employee_id END) AS want_employee_id,
           (CASE WHEN m.is_active AND m.person_type = 'STUDENT' THEN m.student_cc  END) AS want_student_cc,
           CASE
             -- classify by the transition, not just the current column, so a
             -- half-set scan (person id present, person_type null) is reported
             -- as the orphaning it actually is rather than an attach.
             WHEN (m.id IS NULL OR NOT m.is_active) THEN 'WOULD_ORPHAN'
             WHEN s.person_type IS NULL AND s.employee_id IS NULL AND s.student_cc IS NULL THEN 'WOULD_ATTACH'
             ELSE 'WOULD_REPOINT'
           END AS verdict
    FROM zk_attendance_scans s
    LEFT JOIN device_user_mappings m
      ON m.device_sn = s.device_sn AND m.device_pin = s.device_pin
    WHERE s.device_sn <> 'MANUAL'
      AND ( s.person_type IS DISTINCT FROM (CASE WHEN m.is_active THEN m.person_type END)
         OR s.employee_id IS DISTINCT FROM (CASE WHEN m.is_active AND m.person_type = 'STAFF'   THEN m.employee_id END)
         OR s.student_cc  IS DISTINCT FROM (CASE WHEN m.is_active AND m.person_type = 'STUDENT' THEN m.student_cc  END) )
    ORDER BY verdict, s.attendance_date DESC, s.id`;

  const byVerdict = drift.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});
  console.log('=== A. ATTRIBUTION DRIFT (scan vs current mapping) ===');
  console.log(`  total drifted scans: ${drift.length}`);
  console.log(`    WOULD_REPOINT (mis-attributed — scan credited to the wrong person): ${byVerdict.WOULD_REPOINT ?? 0}`);
  console.log(`    WOULD_ATTACH  (orphan scan a mapping now covers):                   ${byVerdict.WOULD_ATTACH ?? 0}`);
  console.log(`    WOULD_ORPHAN  (attributed but mapping is gone/inactive):            ${byVerdict.WOULD_ORPHAN ?? 0}`);
  const repoints = drift.filter((r) => r.verdict === 'WOULD_REPOINT');
  if (repoints.length > 0) {
    console.log('  mis-attributed detail:');
    for (const r of repoints.slice(0, 20)) {
      console.log(
        `    scan #${r.scan_id} ${r.attendance_date} ${r.device_sn}/${r.device_pin}: ` +
          `credited to ${r.cur_type} emp=${r.cur_employee_id ?? '—'} cc=${r.cur_student_cc ?? '—'} ` +
          `→ should be ${r.want_type} emp=${r.want_employee_id ?? '—'} cc=${r.want_student_cc ?? '—'}`,
      );
    }
  }
  const p = writeCsv('zk-audit-a-drift.csv', drift);
  if (p) written.push(p);

  // ── B. BOTH COLUMNS SET — fingerprint of the `?? undefined` bug ────────────
  const bothCols = await prisma.$queryRaw<any[]>`
    SELECT id AS scan_id, device_sn, device_pin, attendance_date::text AS attendance_date,
           person_type::text AS person_type, employee_id, student_cc,
           CASE
             WHEN employee_id IS NOT NULL AND student_cc IS NOT NULL THEN 'BOTH_PERSON_COLUMNS_SET'
             WHEN person_type IS NULL THEN 'PERSON_ID_WITHOUT_TYPE'
             WHEN person_type = 'STAFF'   AND employee_id IS NULL THEN 'TYPE_WITHOUT_ID'
             WHEN person_type = 'STUDENT' AND student_cc  IS NULL THEN 'TYPE_WITHOUT_ID'
             WHEN person_type = 'STAFF'   AND student_cc  IS NOT NULL THEN 'ID_TYPE_MISMATCH'
             WHEN person_type = 'STUDENT' AND employee_id IS NOT NULL THEN 'ID_TYPE_MISMATCH'
           END AS problem
    FROM zk_attendance_scans
    WHERE (employee_id IS NOT NULL AND student_cc IS NOT NULL)
       OR (person_type IS NULL AND (employee_id IS NOT NULL OR student_cc IS NOT NULL))
       OR (person_type = 'STAFF'   AND (employee_id IS NULL OR student_cc IS NOT NULL))
       OR (person_type = 'STUDENT' AND (student_cc  IS NULL OR employee_id IS NOT NULL))
    ORDER BY id`;
  console.log('\n=== B. INCOHERENT PERSON COLUMNS ON SCANS ===');
  console.log(`  count: ${bothCols.length}  (nonzero = person_type/employee_id/student_cc got out of sync)`);
  const byProblem = bothCols.reduce<Record<string, number>>((acc, r) => {
    acc[r.problem] = (acc[r.problem] ?? 0) + 1;
    return acc;
  }, {});
  for (const [k, v] of Object.entries(byProblem)) console.log(`    ${k}: ${v}`);
  const pb = writeCsv('zk-audit-b-both-columns.csv', bothCols);
  if (pb) written.push(pb);

  // ── C. PHANTOM DAILY ROWS — biometric rows with no backing scans ──────────
  const phantomStudent = await prisma.$queryRaw<any[]>`
    SELECT 'STUDENT' AS person_type, d.student_cc AS person_id, d.date::text AS date,
           d.status::text AS status, d.check_in_at::text AS check_in_at
    FROM attendance_student_daily d
    WHERE d.source = 'BIOMETRIC'
      AND NOT EXISTS (SELECT 1 FROM zk_attendance_scans s
                      WHERE s.student_cc = d.student_cc AND s.attendance_date = d.date
                        AND s.person_type = 'STUDENT' AND s.is_duplicate = false)`;
  const phantomStaff = await prisma.$queryRaw<any[]>`
    SELECT 'STAFF' AS person_type, d.employee_id AS person_id, d.date::text AS date,
           d.status::text AS status, d.check_in_at::text AS check_in_at
    FROM attendance_staff_daily d
    WHERE d.source = 'BIOMETRIC'
      AND NOT EXISTS (SELECT 1 FROM zk_attendance_scans s
                      WHERE s.employee_id = d.employee_id AND s.attendance_date = d.date
                        AND s.person_type = 'STAFF' AND s.is_duplicate = false)`;
  const phantom = [...phantomStudent, ...phantomStaff];
  console.log('\n=== C. PHANTOM DAILY ROWS (source=BIOMETRIC, zero backing scans) ===');
  console.log(`  student: ${phantomStudent.length}  staff: ${phantomStaff.length}  total: ${phantom.length}`);
  const pc = writeCsv('zk-audit-c-phantom-daily.csv', phantom);
  if (pc) written.push(pc);

  // ── D. GR/CC NAMESPACE COLLISIONS ─────────────────────────────────────────
  const collisions = await prisma.$queryRaw<any[]>`
    SELECT a.cc AS gr_owner_cc, a.gr_number, a.full_name AS gr_owner_name,
           b.cc AS cc_owner_cc, b.full_name AS cc_owner_name,
           EXISTS (SELECT 1 FROM device_user_mappings m
                   WHERE m.device_pin = a.gr_number AND m.is_active) AS pin_in_use
    FROM students a
    JOIN students b ON b.cc::text = a.gr_number
    WHERE a.gr_number IS NOT NULL AND a.deleted_at IS NULL AND b.deleted_at IS NULL
    ORDER BY pin_in_use DESC, a.cc`;
  const live = collisions.filter((c) => c.pin_in_use);
  console.log('\n=== D. GR/CC COLLISIONS (student A gr_number == student B cc) ===');
  console.log(`  total: ${collisions.length}   currently used as an active device pin: ${live.length}`);
  const pd = writeCsv('zk-audit-d-gr-cc-collisions.csv', collisions);
  if (pd) written.push(pd);

  // ── E. MAPPING HEALTH ─────────────────────────────────────────────────────
  const pinNotCc = await prisma.$queryRaw<any[]>`
    SELECT m.id AS mapping_id, m.device_sn, m.device_pin, m.student_cc, m.is_active,
           s.full_name, s.gr_number
    FROM device_user_mappings m JOIN students s ON s.cc = m.student_cc
    WHERE m.person_type = 'STUDENT' AND m.device_pin !~ '^[0-9]+$' IS FALSE
      AND m.device_pin::bigint <> m.student_cc`;
  const multi = await prisma.$queryRaw<any[]>`
    SELECT person_type::text AS person_type,
           COALESCE(employee_id, student_cc) AS person_id, COUNT(*)::int AS active_mappings
    FROM device_user_mappings WHERE is_active
    GROUP BY person_type, COALESCE(employee_id, student_cc)
    HAVING COUNT(*) > 1 ORDER BY active_mappings DESC`;
  const deletedRef = await prisma.$queryRaw<any[]>`
    SELECT m.id AS mapping_id, m.device_sn, m.device_pin, m.student_cc, s.full_name
    FROM device_user_mappings m JOIN students s ON s.cc = m.student_cc
    WHERE s.deleted_at IS NOT NULL`;
  console.log('\n=== E. MAPPING HEALTH ===');
  console.log(`  student mappings where device_pin != cc:      ${pinNotCc.length}`);
  console.log(`  people with more than one active mapping:     ${multi.length}`);
  console.log(`  mappings pointing at soft-deleted students:   ${deletedRef.length}`);
  const pe1 = writeCsv('zk-audit-e-pin-not-cc.csv', pinNotCc);
  if (pe1) written.push(pe1);
  const pe2 = writeCsv('zk-audit-e-multi-mapping.csv', multi);
  if (pe2) written.push(pe2);
  const pe3 = writeCsv('zk-audit-e-deleted-student-mappings.csv', deletedRef);
  if (pe3) written.push(pe3);

  console.log('\n--- CSVs written ---');
  written.forEach((w) => console.log(`  ${w}`));
  if (written.length === 0) console.log('  (none — all reports empty)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
