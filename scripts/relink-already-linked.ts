/**
 * relink-already-linked.ts
 *
 * For the students listed in already_linked_output.csv (those who already had a
 * guardian link when import-missing-fathers ran):
 *
 *  1. Collect all current student_guardian rows for those students.
 *  2. Delete those student_guardian rows.
 *  3. Delete the linked guardian records ONLY if no other student still references them.
 *  4. Re-upsert father + mother guardians from the data in missing_fathers.csv.
 *  5. Create new student_guardian links.
 *
 * Safety:
 *  - Shared guardians (same CNIC, multiple students) are never deleted.
 *  - DRY_RUN=true (default) prints what would happen without touching the DB.
 *
 * Usage:
 *   DRY_RUN=false npx ts-node -r tsconfig-paths/register scripts/relink-already-linked.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

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

  const alreadyLinkedPath = path.join(__dirname, '..', 'fathers-data', 'already_linked_output.csv');
  if (!fs.existsSync(alreadyLinkedPath)) throw new Error(`File not found: ${alreadyLinkedPath}`);

  const rows: AlreadyLinkedRow[] = parse(fs.readFileSync(alreadyLinkedPath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  console.log(`Loaded ${rows.length} students from already_linked_output.csv\n`);

  const studentCCs = rows.map((r) => parseInt(r.student_cc, 10)).filter((n) => !isNaN(n));

  // ── Step 1: Fetch all current student_guardian rows for these students ──────
  const existingLinks = await prisma.student_guardians.findMany({
    where: { student_id: { in: studentCCs } },
    select: { student_id: true, guardian_id: true, relationship: true },
  });

  console.log(`Found ${existingLinks.length} existing student_guardian links to remove.`);

  const linkedGuardianIds = [...new Set(existingLinks.map((l) => l.guardian_id))];
  console.log(`Unique guardian IDs involved: ${linkedGuardianIds.length}`);

  // ── Step 2: Determine which guardian records will become orphaned ───────────
  // After we delete these links, check if any remaining student_guardians
  // (for OTHER students not in our list) still reference these guardians.
  const otherLinks = await prisma.student_guardians.findMany({
    where: {
      guardian_id: { in: linkedGuardianIds },
      student_id: { notIn: studentCCs },  // other students
    },
    select: { guardian_id: true, student_id: true },
  });

  const guardianIdsWithOtherStudents = new Set(otherLinks.map((l) => l.guardian_id));
  const guardianIdsToDelete = linkedGuardianIds.filter(
    (id) => !guardianIdsWithOtherStudents.has(id),
  );
  const guardianIdsToKeep = linkedGuardianIds.filter((id) =>
    guardianIdsWithOtherStudents.has(id),
  );

  console.log(`Guardians safe to delete (no other students linked):  ${guardianIdsToDelete.length}`);
  console.log(`Guardians to keep (shared with other students):        ${guardianIdsToKeep.length}`);
  if (guardianIdsToKeep.length > 0) {
    console.log(
      `  Kept guardian IDs: ${guardianIdsToKeep.join(', ')}  ← shared, will NOT be deleted`,
    );
  }

  // ── Step 3: Execute deletes ───────────────────────────────────────────────
  if (!dryRun) {
    // Delete student_guardian links first (FK constraint)
    const deletedLinks = await prisma.student_guardians.deleteMany({
      where: { student_id: { in: studentCCs } },
    });
    console.log(`\nDeleted ${deletedLinks.count} student_guardian rows.`);

    // Delete orphaned guardian records
    if (guardianIdsToDelete.length > 0) {
      const deletedGuardians = await prisma.guardians.deleteMany({
        where: { id: { in: guardianIdsToDelete } },
      });
      console.log(`Deleted ${deletedGuardians.count} guardian records.`);
    }
  } else {
    console.log(`\n[DRY RUN] Would delete ${existingLinks.length} student_guardian rows.`);
    console.log(`[DRY RUN] Would delete ${guardianIdsToDelete.length} guardian records.`);
  }

  // ── Step 4: Re-upsert guardians and create links from CSV data ────────────
  const cnicToId = new Map<string, number>();
  let dryRunIdCounter = 800_000;
  let guardiansUpserted = 0;
  let linksCreated = 0;

  type GuardianLink = {
    student_id: number;
    guardian_id: number;
    relationship: string;
    is_primary_contact: boolean;
    is_emergency_contact: boolean;
  };
  const linksToCreate: GuardianLink[] = [];

  async function upsertGuardian(cnic: string, fullName: string): Promise<number> {
    const canonical = normaliseCnic(cnic);
    if (cnicToId.has(canonical)) return cnicToId.get(canonical)!;

    if (dryRun) {
      cnicToId.set(canonical, ++dryRunIdCounter);
      guardiansUpserted++;
      return dryRunIdCounter;
    }

    const g = await prisma.guardians.upsert({
      where: { cnic: canonical },
      create: { cnic: canonical, full_name: fullName || 'Unknown' },
      update: { ...(fullName?.trim() ? { full_name: fullName } : {}) },
    });

    cnicToId.set(canonical, g.id);
    guardiansUpserted++;
    return g.id;
  }

  console.log('\nRe-inserting guardians and links from CSV data...');

  for (const row of rows) {
    const cc = parseInt(row.student_cc, 10);
    if (isNaN(cc)) continue;

    const hasFatherCnic = isValidCnic(row.father_cnic);
    const hasMotherCnic = isValidCnic(row.mother_cnic);

    if (!hasFatherCnic && !hasMotherCnic) {
      console.log(
        `  SKIP CC=${cc} ${row.student_name} — no valid CNIC for either parent; links were deleted`,
      );
      continue;
    }

    if (hasFatherCnic) {
      const gId = await upsertGuardian(row.father_cnic, row.father_name);
      linksToCreate.push({
        student_id: cc,
        guardian_id: gId,
        relationship: 'Father',
        is_primary_contact: true,
        is_emergency_contact: true,
      });
    }

    if (hasMotherCnic) {
      const gId = await upsertGuardian(row.mother_cnic, row.mother_name);
      linksToCreate.push({
        student_id: cc,
        guardian_id: gId,
        relationship: 'Mother',
        is_primary_contact: !hasFatherCnic,
        is_emergency_contact: false,
      });
    }
  }

  if (!dryRun && linksToCreate.length > 0) {
    const BATCH = 50;
    for (let i = 0; i < linksToCreate.length; i += BATCH) {
      const result = await prisma.student_guardians.createMany({
        data: linksToCreate.slice(i, i + BATCH),
        skipDuplicates: true,
      });
      linksCreated += result.count;
    }
  } else if (dryRun) {
    linksCreated = linksToCreate.length;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(dryRun ? 'DRY RUN SUMMARY' : 'RELINK COMPLETE');
  console.log('══════════════════════════════════════════════════════');
  console.log(`Students processed:              ${rows.length}`);
  console.log(`Old links removed:               ${dryRun ? existingLinks.length + ' (simulated)' : existingLinks.length}`);
  console.log(`Old guardians deleted:           ${dryRun ? guardianIdsToDelete.length + ' (simulated)' : guardianIdsToDelete.length}`);
  console.log(`Old guardians kept (shared):     ${guardianIdsToKeep.length}`);
  console.log(`Guardians upserted (new):        ${guardiansUpserted}`);
  console.log(`Student-guardian links created:  ${linksCreated}`);

  if (dryRun) {
    console.log('\nLinks that would be created:');
    for (const l of linksToCreate) {
      const row = rows.find((r) => parseInt(r.student_cc, 10) === l.student_id)!;
      console.log(
        `  CC=${l.student_id} ${row?.student_name} ← [${l.relationship}] primary=${l.is_primary_contact}`,
      );
    }
    console.log('\nRe-run with DRY_RUN=false to apply changes.');
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
