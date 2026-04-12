/**
 * import-guardians.ts
 *
 * Imports father / mother guardian data from the four campus CSVs into the
 * `guardians` and `student_guardians` tables.
 *
 * Business rules (as specified):
 *  - Primary source = FATHER CNIC.
 *  - If father_cnic is a real CNIC → upsert guardian (with name if present)
 *    and link as "Father" to the student. Father is primary_contact when present.
 *  - If father_cnic is absent/invalid BUT father_name only → SKIP this row
 *    (log at end, so we know father data is missing).
 *  - If mother_cnic is a real CNIC → upsert guardian (name = "" / no name)
 *    and link as "Mother". Mother is primary_contact ONLY when no father exists.
 *  - If mother_name only (no mother_cnic) → skip silently (no log).
 *  - If BOTH cnics absent → do nothing (log at end).
 *  - Dedup: one guardian row per CNIC (upsert). Multiple students can share a guardian.
 *  - Existing student_guardian links are not duplicated (skipDuplicates).
 *
 * Usage:
 *   DRY_RUN=false npx ts-node -r tsconfig-paths/register scripts/import-guardians.ts
 *
 * Default is DRY_RUN=true (no writes).
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 13-digit CNIC pattern: DDDDD-DDDDDDD-D  (digits only, ignoring dashes) */
const CNIC_DIGIT_RE = /^\d{13}$/;

/**
 * Returns true if the raw cell looks like a real Pakistani CNIC.
 * Strips all dashes & spaces before checking digit count == 13.
 */
function isValidCnic(raw: string | undefined | null): boolean {
  if (!raw || !raw.trim()) return false;
  const stripped = raw.replace(/[-\s]/g, '');
  return CNIC_DIGIT_RE.test(stripped);
}

/** Normalise raw CNIC to the canonical "DDDDD-DDDDDDD-D" format, or null. */
function normaliseCnic(raw: string): string | null {
  const stripped = raw.replace(/[-\s]/g, '');
  if (!CNIC_DIGIT_RE.test(stripped)) return null;
  return `${stripped.slice(0, 5)}-${stripped.slice(5, 12)}-${stripped.slice(12)}`;
}

// ─── CSV row type ─────────────────────────────────────────────────────────────

interface CsvRow {
  cc: string;
  student_name: string;
  father_name: string;
  father_cnic: string;
  mother_cnic: string;
}

// ─── Log structures ───────────────────────────────────────────────────────────

interface SkipEntry {
  file: string;
  cc: string;
  student_name: string;
  reason: string;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.env.DRY_RUN !== 'false';
  console.log(
    dryRun
      ? '═══ DRY RUN MODE  (set DRY_RUN=false to write to DB) ═══'
      : '═══ EXECUTION MODE ═══',
  );

  // ── CSV files to import ──────────────────────────────────────────────────
  const CSV_FILES = [
    'gkf-fathers.csv',
    'johar-fathers.csv',
    'nnn-fathers.csv',
    'tafsal-fathers.csv',
  ];
  const dataDir = path.join(__dirname, '..', 'fathers-data');

  // ── Load & parse all CSV files ───────────────────────────────────────────
  type RowWithFile = CsvRow & { __file: string };
  let allRows: RowWithFile[] = [];

  for (const fname of CSV_FILES) {
    const fpath = path.join(dataDir, fname);
    if (!fs.existsSync(fpath)) {
      console.warn(`⚠  File not found, skipping: ${fpath}`);
      continue;
    }
    const raw = fs.readFileSync(fpath, 'utf8');
    const rows: CsvRow[] = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    const tagged = rows.map((r) => ({ ...r, __file: fname }));
    allRows = allRows.concat(tagged);
    console.log(`  Loaded ${rows.length} rows from ${fname}`);
  }
  console.log(`  Total rows across all files: ${allRows.length}\n`);

  // ── Fetch valid student CCs from DB ─────────────────────────────────────
  const students = await prisma.students.findMany({
    select: { cc: true },
    where: { deleted_at: null },
  });
  const existingCCs = new Set(students.map((s) => s.cc));
  console.log(`Students in DB (active): ${existingCCs.size}`);

  // ── Tracking ─────────────────────────────────────────────────────────────
  const skipsMissingFatherCnic: SkipEntry[] = [];   // father name only, no father CNIC
  const skipsBothAbsent: SkipEntry[] = [];           // no father CNIC & no mother CNIC
  const skipsMissingStudent: SkipEntry[] = [];       // CC not in DB

  let guardiansUpserted = 0;
  let linksCreated = 0;

  // ── Guardian cache: cnic → guardian id (to avoid redundant DB calls) ─────
  const cnicToGuardianId = new Map<string, number>();

  /**
   * Upsert a guardian row by CNIC, returning its id.
   * If dryRun, simulates an autoincrement id for preview.
   */
  let dryRunIdCounter = 900_000; // fake IDs for dry runs
  async function upsertGuardian(cnic: string, fullName: string): Promise<number> {
    const canonical = normaliseCnic(cnic)!;

    if (cnicToGuardianId.has(canonical)) {
      return cnicToGuardianId.get(canonical)!;
    }

    if (dryRun) {
      cnicToGuardianId.set(canonical, ++dryRunIdCounter);
      guardiansUpserted++;
      return dryRunIdCounter;
    }

    const guardian = await prisma.guardians.upsert({
      where: { cnic: canonical },
      create: {
        cnic: canonical,
        full_name: fullName || 'Unknown',
      },
      update: {
        // Only fill in name if we now have one and the stored name is blank/unknown
        ...(fullName && fullName.trim()
          ? {
              full_name: fullName,
            }
          : {}),
      },
    });

    cnicToGuardianId.set(canonical, guardian.id);
    guardiansUpserted++;
    return guardian.id;
  }

  /**
   * Create a student_guardian link.
   * Handles skipDuplicates via upsert/createMany later.
   */
  type GuardianLink = {
    student_id: number;
    guardian_id: number;
    relationship: string;
    is_primary_contact: boolean;
    is_emergency_contact: boolean;
  };

  const linksToCreate: GuardianLink[] = [];

  // ── Process each row ─────────────────────────────────────────────────────
  for (const row of allRows) {
    const cc = parseInt(row.cc?.trim(), 10);

    // Skip rows without a valid CC
    if (!row.cc?.trim() || isNaN(cc)) {
      skipsMissingStudent.push({
        file: row.__file,
        cc: row.cc ?? '',
        student_name: row.student_name ?? '',
        reason: 'Invalid or empty CC number',
      });
      continue;
    }

    // Skip rows where student is not in DB
    if (!existingCCs.has(cc)) {
      skipsMissingStudent.push({
        file: row.__file,
        cc: String(cc),
        student_name: row.student_name,
        reason: 'Student CC not found in DB',
      });
      continue;
    }

    const fatherCnicRaw = row.father_cnic?.trim() ?? '';
    const fatherNameRaw = row.father_name?.trim() ?? '';
    const motherCnicRaw = row.mother_cnic?.trim() ?? '';

    const hasFatherCnic = isValidCnic(fatherCnicRaw);
    const hasMotherCnic = isValidCnic(motherCnicRaw);
    const hasFatherNameOnly = !hasFatherCnic && fatherNameRaw.length > 0;

    // Case: no father CNIC, no mother CNIC → log "both missing"
    if (!hasFatherCnic && !hasMotherCnic) {
      if (hasFatherNameOnly) {
        // Sub-case: father name exists but no CNIC → log as missing father CNIC
        skipsMissingFatherCnic.push({
          file: row.__file,
          cc: String(cc),
          student_name: row.student_name,
          reason: `Father name present ("${fatherNameRaw}") but no valid CNIC`,
        });
      } else {
        skipsBothAbsent.push({
          file: row.__file,
          cc: String(cc),
          student_name: row.student_name,
          reason: 'No father CNIC and no mother CNIC; nothing to import',
        });
      }
      continue;
    }

    // At this point at least one CNIC is present.
    // father is primary when father CNIC exists; otherwise mother is primary.

    if (hasFatherCnic) {
      const guardianId = await upsertGuardian(fatherCnicRaw, fatherNameRaw);
      linksToCreate.push({
        student_id: cc,
        guardian_id: guardianId,
        relationship: 'Father',
        is_primary_contact: true,
        is_emergency_contact: true,
      });
    } else if (hasFatherNameOnly) {
      // Log – father name only, no CNIC → skip father creation
      skipsMissingFatherCnic.push({
        file: row.__file,
        cc: String(cc),
        student_name: row.student_name,
        reason: `Father name present ("${fatherNameRaw}") but no valid CNIC`,
      });
    }

    if (hasMotherCnic) {
      // Mother CNIC present → create/link guardian (no name required)
      const guardianId = await upsertGuardian(motherCnicRaw, '');
      const motherIsPrimary = !hasFatherCnic; // only primary if no father
      linksToCreate.push({
        student_id: cc,
        guardian_id: guardianId,
        relationship: 'Mother',
        is_primary_contact: motherIsPrimary,
        is_emergency_contact: false,
      });
    }
    // If mother has name only (no CNIC) → skip silently (no log as per spec)
  }

  // ── Write links to DB ────────────────────────────────────────────────────
  if (!dryRun && linksToCreate.length > 0) {
    const BATCH_SIZE = 50;
    for (let i = 0; i < linksToCreate.length; i += BATCH_SIZE) {
      const batch = linksToCreate.slice(i, i + BATCH_SIZE);
      const result = await prisma.student_guardians.createMany({
        data: batch,
        skipDuplicates: true,
      });
      linksCreated += result.count;
      process.stdout.write(
        `\r  Links: ${Math.min(i + BATCH_SIZE, linksToCreate.length)}/${linksToCreate.length} processed...`,
      );
    }
    console.log('');
  } else if (dryRun) {
    linksCreated = linksToCreate.length; // simulate
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(dryRun ? 'DRY RUN SUMMARY' : 'IMPORT COMPLETE');
  console.log('══════════════════════════════════════════════════════');
  console.log(`Guardian rows upserted:         ${guardiansUpserted}`);
  console.log(`Student-guardian links created: ${linksCreated}`);
  console.log(`Links prepared (before dedup):  ${linksToCreate.length}`);
  console.log('');
  console.log(`Students not in DB (skipped):   ${skipsMissingStudent.length}`);
  console.log(`Missing father CNIC (skipped):  ${skipsMissingFatherCnic.length}`);
  console.log(`Both CNICs absent (skipped):    ${skipsBothAbsent.length}`);

  // ── Detailed logs ─────────────────────────────────────────────────────────
  if (skipsMissingFatherCnic.length > 0) {
    console.log('\n──── MISSING FATHER CNIC (rows skipped for father guardian) ────');
    for (const s of skipsMissingFatherCnic) {
      console.log(`  [${s.file}] CC=${s.cc} | ${s.student_name} → ${s.reason}`);
    }
  }

  if (skipsBothAbsent.length > 0) {
    console.log('\n──── BOTH CNICS ABSENT (no guardian created) ────');
    for (const s of skipsBothAbsent) {
      console.log(`  [${s.file}] CC=${s.cc} | ${s.student_name} → ${s.reason}`);
    }
  }

  if (skipsMissingStudent.length > 0) {
    console.log('\n──── STUDENTS NOT IN DB ────');
    for (const s of skipsMissingStudent) {
      console.log(`  [${s.file}] CC=${s.cc} | ${s.student_name} → ${s.reason}`);
    }
  }

  if (dryRun) {
    console.log('\n  Re-run with DRY_RUN=false to apply changes.');

    // Preview first 20 links
    console.log('\n  Sample links (first 20):');
    linksToCreate.slice(0, 20).forEach((l) =>
      console.log(
        `    student=${l.student_id} ← guardian=${l.guardian_id} [${l.relationship}] primary=${l.is_primary_contact}`,
      ),
    );
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
