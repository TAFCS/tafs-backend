/**
 * seed-esm-guardians.ts
 *
 * Cross-references esm.csv against the Supabase CSV exports
 * (students_rows.csv, guardians_rows.csv, student_guardians_rows.csv)
 * to detect anomalies and insert missing FATHER guardians into the live DB.
 *
 * Input files (all in /prisma/):
 *   esm.csv                    - source: columns C.C., GR Number, Name, Father Name
 *   students_rows.csv          - Supabase export of students table
 *   guardians_rows.csv         - Supabase export of guardians table
 *   student_guardians_rows.csv - Supabase export of student_guardians table
 *
 * ANOMALY DETECTION (offline, against CSV exports):
 *   [CC_NOT_FOUND]      CC in ESM not present in students_rows.csv
 *   [NAME_MISMATCH]     Student name in ESM ≠ full_name in students_rows.csv
 *   [GR_MISMATCH]       GR Number in ESM ≠ gr_number in students_rows.csv
 *   [NO_FATHER_NAME]    Father Name column is blank in ESM
 *   [DUPLICATE_CC]      Same CC appears more than once in ESM
 *   [FATHER_NAME_DIFF]  Student already has a FATHER guardian but the name
 *                       in the DB differs from the ESM Father Name
 *
 * FILL-IN (live DB write):
 *   - Students who have NO FATHER in student_guardians_rows.csv
 *     AND have a Father Name in ESM → create guardian + link
 *   - Students who already have a FATHER → skipped (no overwrite)
 *
 * Anomaly report written to esm-anomalies.log
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();

const CSV_PATH         = path.resolve(__dirname, 'esm.csv');
const STUDENTS_CSV     = path.resolve(__dirname, 'students_rows.csv');
const GUARDIANS_CSV    = path.resolve(__dirname, 'guardians_rows.csv');
const STU_GUARD_CSV    = path.resolve(__dirname, 'student_guardians_rows.csv');
const LOG_PATH         = path.resolve(__dirname, 'esm-anomalies.log');

// ── helpers ───────────────────────────────────────────────────────────────────

function normalise(s: string | null | undefined): string {
  return (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function parseCsv(filePath: string): Array<Record<string, string>> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true });
}

function log(lines: string[]): void {
  fs.appendFileSync(LOG_PATH, lines.join('\n') + '\n');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  for (const p of [CSV_PATH, STUDENTS_CSV, GUARDIANS_CSV, STU_GUARD_CSV]) {
    if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
  }

  // Reset log
  fs.writeFileSync(
    LOG_PATH,
    `ESM Guardian Seed — Anomaly Report\nRun: ${new Date().toISOString()}\n${'='.repeat(70)}\n\n`,
  );

  // ── Load all CSVs into memory ──────────────────────────────────────────────
  const esmRows      = parseCsv(CSV_PATH);
  const studentRows  = parseCsv(STUDENTS_CSV);
  const guardianRows = parseCsv(GUARDIANS_CSV);
  const sgRows       = parseCsv(STU_GUARD_CSV);

  console.log(`ESM rows:               ${esmRows.length}`);
  console.log(`DB students:            ${studentRows.length}`);
  console.log(`DB guardians:           ${guardianRows.length}`);
  console.log(`DB student_guardians:   ${sgRows.length}`);

  // ── Build lookup maps from DB exports ─────────────────────────────────────
  // students: cc → { full_name, gr_number }
  const studentMap = new Map<number, { full_name: string; gr_number: string }>();
  for (const row of studentRows) {
    const cc = parseInt(row['cc'], 10);
    if (!isNaN(cc)) {
      studentMap.set(cc, {
        full_name: row['full_name'] ?? '',
        gr_number: row['gr_number'] ?? '',
      });
    }
  }

  // guardians: id → full_name
  const guardianMap = new Map<number, string>();
  for (const row of guardianRows) {
    const id = parseInt(row['id'], 10);
    if (!isNaN(id)) guardianMap.set(id, row['full_name'] ?? '');
  }

  // student_guardians: student_id → [ { guardian_id, relationship } ]
  const sgMap = new Map<number, Array<{ guardian_id: number; relationship: string }>>();
  for (const row of sgRows) {
    const sid = parseInt(row['student_id'], 10);
    const gid = parseInt(row['guardian_id'], 10);
    if (isNaN(sid) || isNaN(gid)) continue;
    if (!sgMap.has(sid)) sgMap.set(sid, []);
    sgMap.get(sid)!.push({ guardian_id: gid, relationship: row['relationship'] });
  }

  // ── 1. Detect duplicate CCs inside ESM ────────────────────────────────────
  const ccCount = new Map<number, number>();
  for (const row of esmRows) {
    const cc = parseInt(row['C.C.'], 10);
    if (!isNaN(cc)) ccCount.set(cc, (ccCount.get(cc) ?? 0) + 1);
  }
  const duplicateCCs = [...ccCount.entries()].filter(([, n]) => n > 1);

  const dupLines: string[] = ['── [DUPLICATE_CC] Same CC appears multiple times in ESM ─────────────'];
  let dupCount = 0;
  for (const [cc, n] of duplicateCCs) {
    dupLines.push(`  CC=${cc}  count=${n}`);
    dupCount++;
  }
  if (dupCount === 0) dupLines.push('  (none)');
  dupLines.push('');
  log(dupLines);
  if (dupCount > 0) dupLines.forEach((l) => console.warn(l));

  // ── 2. Per-row anomaly scan ────────────────────────────────────────────────
  const anomalyLines: string[] = ['── Per-row anomalies ────────────────────────────────────────────────'];

  // Track rows to insert: only first occurrence of each CC, only missing FATHER
  const seen = new Set<number>();
  const toInsert: Array<{ cc: number; fatherName: string }> = [];

  let totalAnomalies = 0;
  let fatherSkipped  = 0;

  for (const row of esmRows) {
    const cc         = parseInt(row['C.C.'], 10);
    const csvName    = normalise(row['Name']);
    const fatherName = normalise(row['Father Name']);
    const grNumber   = (row['GR Number'] ?? '').trim();

    if (isNaN(cc)) {
      anomalyLines.push(`  [INVALID_CC]       raw="${row['C.C.']}"  name="${row['Name']}"`);
      totalAnomalies++;
      continue;
    }

    // ── Missing father name ──────────────────────────────────────────────
    if (!fatherName) {
      anomalyLines.push(`  [NO_FATHER_NAME]   CC=${cc}  GR=${grNumber}  student="${csvName}"`);
      totalAnomalies++;
    }

    // ── Student not in DB ────────────────────────────────────────────────
    const dbStudent = studentMap.get(cc);
    if (!dbStudent) {
      anomalyLines.push(`  [CC_NOT_FOUND]     CC=${cc}  GR=${grNumber}  esm_name="${csvName}"`);
      totalAnomalies++;
      continue;
    }

    // ── Name mismatch ────────────────────────────────────────────────────
    const dbName = normalise(dbStudent.full_name);
    if (csvName && dbName !== csvName) {
      anomalyLines.push(
        `  [NAME_MISMATCH]    CC=${cc}  GR=${grNumber}  esm="${csvName}"  db="${dbName}"`,
      );
      totalAnomalies++;
    }

    // ── GR number mismatch ───────────────────────────────────────────────
    const dbGr = dbStudent.gr_number.trim();
    if (grNumber && dbGr && dbGr !== grNumber) {
      anomalyLines.push(
        `  [GR_MISMATCH]      CC=${cc}  esm_gr="${grNumber}"  db_gr="${dbGr}"  student="${dbName}"`,
      );
      totalAnomalies++;
    }

    // ── Check existing FATHER guardian ───────────────────────────────────
    const links = sgMap.get(cc) ?? [];
    const fatherLink = links.find((l) => l.relationship === 'FATHER');

    if (fatherLink) {
      // Compare existing guardian name vs ESM father name
      const existingName = normalise(guardianMap.get(fatherLink.guardian_id));
      if (fatherName && existingName && existingName !== fatherName) {
        anomalyLines.push(
          `  [FATHER_NAME_DIFF] CC=${cc}  GR=${grNumber}  esm="${fatherName}"  db="${existingName}"  guardian_id=${fatherLink.guardian_id}`,
        );
        totalAnomalies++;
      }
      fatherSkipped++;
      continue;
    }

    // ── Queue for insert (first occurrence of CC only) ───────────────────
    if (fatherName && !seen.has(cc)) {
      seen.add(cc);
      toInsert.push({ cc, fatherName });
    }
  }

  anomalyLines.push('');
  log(anomalyLines);
  anomalyLines.forEach((l) => console.log(l));

  // ── 3. Insert missing FATHER guardians ────────────────────────────────────
  console.log(`\nInserting ${toInsert.length} missing FATHER guardians...`);

  let fatherCreated = 0;
  let errors        = 0;

  for (const { cc, fatherName } of toInsert) {
    try {
      const guardian = await prisma.guardians.create({
        data: { full_name: fatherName },
      });
      await prisma.student_guardians.create({
        data: {
          student_id:        cc,
          guardian_id:       guardian.id,
          relationship:      'FATHER',
          is_primary_contact: true,
        },
      });
      fatherCreated++;
    } catch (e) {
      console.error(`  ERROR inserting father for cc=${cc}:`, e);
      errors++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = [
    '',
    '='.repeat(70),
    'SUMMARY',
    `  ESM rows total           : ${esmRows.length}`,
    `  Duplicate CCs in ESM     : ${dupCount}`,
    `  Total anomalies flagged  : ${totalAnomalies}`,
    `    (see esm-anomalies.log for full breakdown)`,
    `  Students already have FATHER (skipped) : ${fatherSkipped}`,
    `  FATHER guardians inserted              : ${fatherCreated}`,
    `  Errors during insert                   : ${errors}`,
    '='.repeat(70),
  ].join('\n');

  console.log(summary);
  log([summary]);
  console.log(`\nFull report: ${LOG_PATH}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
