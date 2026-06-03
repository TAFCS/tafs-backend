/**
 * import-missing-fathers.ts
 *
 * Imports guardian data from fathers-data/missing_fathers.csv into the
 * `guardians` and `student_guardians` tables.
 *
 * Logic:
 *  1. Clean the CSV (skip rows with no usable CC or guardian data).
 *  2. For each student, check whether they already have ANY guardian linked.
 *     - Already linked  → write to already_linked_output.csv (separate sheet).
 *     - Not linked      → upsert father and/or mother, then create links.
 *  3. CNIC is the unique key for guardians (upsert / skip duplicates).
 *  4. Father is primary_contact when present; mother is primary_contact only
 *     when no father CNIC exists.
 *  5. Rows where neither CNIC is valid are skipped and logged.
 *
 * Usage:
 *   DRY_RUN=false npx ts-node -r tsconfig-paths/register scripts/import-missing-fathers.ts
 *
 * Default is DRY_RUN=true (no writes).
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
/** Escape a CSV cell value (quote if it contains comma, quote, or newline). */
function csvCell(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function toCSV<T extends object>(rows: T[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((r) =>
      headers.map((h) => csvCell(String((r as Record<string, unknown>)[h] ?? ''))).join(','),
    ),
  ];
  return lines.join('\r\n') + '\r\n';
}

const prisma = new PrismaClient();

// ─── CNIC helpers ─────────────────────────────────────────────────────────────

const CNIC_DIGIT_RE = /^\d{13}$/;

function isValidCnic(raw: string | undefined | null): boolean {
  if (!raw || !raw.trim()) return false;
  const stripped = raw.replace(/[-\s]/g, '');
  return CNIC_DIGIT_RE.test(stripped);
}

function normaliseCnic(raw: string): string {
  const stripped = raw.replace(/[-\s]/g, '');
  return `${stripped.slice(0, 5)}-${stripped.slice(5, 12)}-${stripped.slice(12)}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CsvRow {
  'Student CC': string;
  'GR Number': string;
  'Full Name': string;
  'Class': string;
  'Father Name': string;
  'Father CNIC': string;
  'Mother Name': string;
  'Mother CNIC': string;
  [key: string]: string; // trailing empty column from CSV
}

interface AlreadyLinkedRow {
  student_cc: string;
  gr_number: string;
  student_name: string;
  class: string;
  father_name: string;
  father_cnic: string;
  mother_name: string;
  mother_cnic: string;
  existing_links: string;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.env.DRY_RUN !== 'false';
  console.log(
    dryRun
      ? '═══ DRY RUN MODE  (set DRY_RUN=false to write to DB) ═══'
      : '═══ EXECUTION MODE ═══',
  );

  const csvPath = path.join(__dirname, '..', 'fathers-data', 'missing_fathers.csv');
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  // ── Parse CSV ────────────────────────────────────────────────────────────
  const raw = fs.readFileSync(csvPath, 'utf8');
  const allRows: CsvRow[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true, // trailing comma adds an extra empty column
  });
  console.log(`Parsed ${allRows.length} rows from missing_fathers.csv\n`);

  // ── Fetch active students from DB ─────────────────────────────────────────
  const dbStudents = await prisma.students.findMany({
    select: { cc: true },
    where: { deleted_at: null },
  });
  const existingCCs = new Set(dbStudents.map((s) => s.cc));
  console.log(`Active students in DB: ${existingCCs.size}`);

  // ── Fetch students that already have at least one guardian linked ─────────
  const linkedRows = await prisma.student_guardians.findMany({
    select: { student_id: true, relationship: true },
  });

  // Map: student_id → array of relationship strings
  const linkedMap = new Map<number, string[]>();
  for (const lr of linkedRows) {
    if (!linkedMap.has(lr.student_id)) linkedMap.set(lr.student_id, []);
    linkedMap.get(lr.student_id)!.push(lr.relationship);
  }
  console.log(`Students with existing guardian links: ${linkedMap.size}\n`);

  // ── Tracking ──────────────────────────────────────────────────────────────
  const alreadyLinked: AlreadyLinkedRow[] = [];
  const skippedNotInDb: CsvRow[] = [];
  const skippedNoCnic: CsvRow[] = [];
  const guardiansToCreate: { cnic: string; full_name: string }[] = [];

  type GuardianLink = {
    student_id: number;
    guardian_id: number;
    relationship: string;
    is_primary_contact: boolean;
    is_emergency_contact: boolean;
  };
  const linksToCreate: GuardianLink[] = [];

  // Guardian cache: canonical_cnic → guardian id
  const cnicToId = new Map<string, number>();
  let dryRunIdCounter = 900_000;
  let guardiansUpserted = 0;

  async function upsertGuardian(cnic: string, fullName: string): Promise<number> {
    const canonical = normaliseCnic(cnic);
    if (cnicToId.has(canonical)) return cnicToId.get(canonical)!;

    if (dryRun) {
      cnicToId.set(canonical, ++dryRunIdCounter);
      guardiansUpserted++;
      guardiansToCreate.push({ cnic: canonical, full_name: fullName || 'Unknown' });
      return dryRunIdCounter;
    }

    const guardian = await prisma.guardians.upsert({
      where: { cnic: canonical },
      create: {
        cnic: canonical,
        full_name: fullName || 'Unknown',
      },
      update: {
        // Update name only when we have one and the stored value is blank/Unknown
        ...(fullName && fullName.trim()
          ? { full_name: fullName }
          : {}),
      },
    });

    cnicToId.set(canonical, guardian.id);
    guardiansUpserted++;
    return guardian.id;
  }

  // ── Process each row ──────────────────────────────────────────────────────
  for (const row of allRows) {
    const ccRaw = row['Student CC']?.trim();
    const cc = parseInt(ccRaw, 10);

    // Skip rows with no valid CC
    if (!ccRaw || isNaN(cc)) continue;

    // Skip rows where student is not in DB
    if (!existingCCs.has(cc)) {
      skippedNotInDb.push(row);
      continue;
    }

    const fatherName = row['Father Name']?.trim() ?? '';
    const fatherCnic = row['Father CNIC']?.trim() ?? '';
    const motherName = row['Mother Name']?.trim() ?? '';
    const motherCnic = row['Mother CNIC']?.trim() ?? '';

    const hasFatherCnic = isValidCnic(fatherCnic);
    const hasMotherCnic = isValidCnic(motherCnic);

    // Skip rows where neither CNIC is present (nothing to import)
    if (!hasFatherCnic && !hasMotherCnic) {
      skippedNoCnic.push(row);
      continue;
    }

    // Check if this student already has guardian links
    if (linkedMap.has(cc)) {
      alreadyLinked.push({
        student_cc: ccRaw,
        gr_number: row['GR Number']?.trim() ?? '',
        student_name: row['Full Name']?.trim() ?? '',
        class: row['Class']?.trim() ?? '',
        father_name: fatherName,
        father_cnic: fatherCnic,
        mother_name: motherName,
        mother_cnic: motherCnic,
        existing_links: linkedMap.get(cc)!.join(', '),
      });
      continue;
    }

    // ── Upsert father ────────────────────────────────────────────────────
    if (hasFatherCnic) {
      const guardianId = await upsertGuardian(fatherCnic, fatherName);
      linksToCreate.push({
        student_id: cc,
        guardian_id: guardianId,
        relationship: 'Father',
        is_primary_contact: true,
        is_emergency_contact: true,
      });
    }

    // ── Upsert mother ────────────────────────────────────────────────────
    if (hasMotherCnic) {
      const guardianId = await upsertGuardian(motherCnic, motherName);
      linksToCreate.push({
        student_id: cc,
        guardian_id: guardianId,
        relationship: 'Mother',
        is_primary_contact: !hasFatherCnic,
        is_emergency_contact: false,
      });
    }
  }

  // ── Write guardian links to DB ───────────────────────────────────────────
  let linksCreated = 0;
  if (!dryRun && linksToCreate.length > 0) {
    const BATCH = 50;
    for (let i = 0; i < linksToCreate.length; i += BATCH) {
      const batch = linksToCreate.slice(i, i + BATCH);
      const result = await prisma.student_guardians.createMany({
        data: batch,
        skipDuplicates: true,
      });
      linksCreated += result.count;
      process.stdout.write(
        `\r  Links: ${Math.min(i + BATCH, linksToCreate.length)}/${linksToCreate.length} processed...`,
      );
    }
    console.log('');
  } else if (dryRun) {
    linksCreated = linksToCreate.length;
  }

  // ── Write already_linked CSV ─────────────────────────────────────────────
  const outputPath = path.join(
    __dirname,
    '..',
    'fathers-data',
    'already_linked_output.csv',
  );
  if (alreadyLinked.length > 0) {
    const csvOut = toCSV(alreadyLinked);
    if (!dryRun) {
      fs.writeFileSync(outputPath, csvOut, 'utf8');
      console.log(`\nWrote already_linked_output.csv (${alreadyLinked.length} rows) → ${outputPath}`);
    } else {
      console.log(`\n[DRY RUN] Would write already_linked_output.csv (${alreadyLinked.length} rows)`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(dryRun ? 'DRY RUN SUMMARY' : 'IMPORT COMPLETE');
  console.log('══════════════════════════════════════════════════════');
  console.log(`Total CSV rows parsed:            ${allRows.length}`);
  console.log(`Guardians upserted:               ${guardiansUpserted}`);
  console.log(`Student-guardian links created:   ${linksCreated}`);
  console.log(`Links prepared (before dedup):    ${linksToCreate.length}`);
  console.log('');
  console.log(`Already had guardian(s) → CSV:    ${alreadyLinked.length}`);
  console.log(`Student CC not in DB (skipped):   ${skippedNotInDb.length}`);
  console.log(`No valid CNIC at all (skipped):   ${skippedNoCnic.length}`);

  if (skippedNotInDb.length > 0) {
    console.log('\n──── CC NOT IN DB ────');
    for (const r of skippedNotInDb) {
      console.log(`  CC=${r['Student CC']} | ${r['Full Name']} | ${r['Class']}`);
    }
  }

  if (skippedNoCnic.length > 0) {
    console.log('\n──── NO VALID CNIC (nothing to import) ────');
    for (const r of skippedNoCnic) {
      console.log(
        `  CC=${r['Student CC']} | ${r['Full Name']} | Father: "${r['Father Name']}" | Mother: "${r['Mother Name']}"`,
      );
    }
  }

  if (dryRun) {
    console.log('\n  Re-run with DRY_RUN=false to apply changes.');
    if (linksToCreate.length > 0) {
      console.log('\n  Sample links (first 20):');
      linksToCreate.slice(0, 20).forEach((l) =>
        console.log(
          `    student=${l.student_id} ← guardian=${l.guardian_id} [${l.relationship}] primary=${l.is_primary_contact}`,
        ),
      );
    }
    if (guardiansToCreate.length > 0) {
      console.log('\n  Sample guardians (first 20):');
      guardiansToCreate.slice(0, 20).forEach((g) =>
        console.log(`    CNIC=${g.cnic} | ${g.full_name}`),
      );
    }
  }
}

main()
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
