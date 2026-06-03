/**
 * create-families.ts
 *
 * Executes family creation based on father CNIC grouping:
 *  1. Groups all students by their father guardian's CNIC.
 *  2. For each group where NO student has a family_id yet:
 *       - Creates a new families row  (household_name = father name, email = null, password_hash = null)
 *       - Sets family_id on all students in the group.
 *  3. Hard-coded fix: CC=7717 ZAHRA → assigned to existing family fam_id=2629 (NAZIM ALI family,
 *     sibling FATIMA CC=7944 is already there).
 *
 * Students who already have a family_id are never touched.
 * Groups where the father guardian has no CNIC are skipped.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/create-families.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('═══ FAMILY CREATION ═══\n');

  // ── Fetch active students ─────────────────────────────────────────────────
  const students = await prisma.students.findMany({
    where: { deleted_at: null },
    select: { cc: true, full_name: true, family_id: true, classes: { select: { description: true } } },
  });
  const studentMap = new Map(students.map((s) => [s.cc, s]));
  console.log(`Active students: ${students.length}`);

  // ── Fetch all student_guardian links ──────────────────────────────────────
  const allLinks = await prisma.student_guardians.findMany({
    select: { student_id: true, guardian_id: true, relationship: true },
  });

  // ── Fetch guardians ───────────────────────────────────────────────────────
  const guardianIds = [...new Set(allLinks.map((l) => l.guardian_id))];
  const guardians = await prisma.guardians.findMany({
    where: { id: { in: guardianIds } },
    select: { id: true, cnic: true, full_name: true },
  });
  const guardianMap = new Map(guardians.map((g) => [g.id, g]));

  // ── Build per-student father index ────────────────────────────────────────
  const studentFatherMap = new Map<number, number>(); // cc → guardian_id
  for (const link of allLinks) {
    if (link.relationship.toLowerCase() === 'father') {
      studentFatherMap.set(link.student_id, link.guardian_id);
    }
  }

  // ── Group students by father CNIC ─────────────────────────────────────────
  type FamilyGroup = {
    cnic: string;
    householdName: string;
    guardianId: number;
    newStudents: number[];         // CCs with no family_id
    alreadyAssigned: number[];     // CCs that already have a family_id
  };

  const groups = new Map<string, FamilyGroup>();

  for (const [cc, guardianId] of studentFatherMap.entries()) {
    const g = guardianMap.get(guardianId);
    if (!g?.cnic) continue;

    if (!groups.has(g.cnic)) {
      groups.set(g.cnic, {
        cnic: g.cnic,
        householdName: g.full_name || 'Unknown Household',
        guardianId,
        newStudents: [],
        alreadyAssigned: [],
      });
    }

    const group = groups.get(g.cnic)!;
    const student = studentMap.get(cc);
    if (student?.family_id != null) {
      group.alreadyAssigned.push(cc);
    } else {
      group.newStudents.push(cc);
    }
  }

  // ── Classify ──────────────────────────────────────────────────────────────
  const toCreate: FamilyGroup[] = [];
  const partialGroups: FamilyGroup[] = [];
  let skippedFullyAssigned = 0;

  for (const group of groups.values()) {
    if (group.alreadyAssigned.length === 0) {
      toCreate.push(group);
    } else if (group.newStudents.length > 0) {
      partialGroups.push(group);
    } else {
      skippedFullyAssigned++;
    }
  }

  console.log(`Groups to create as new families:      ${toCreate.length}`);
  console.log(`Partial groups (manual merge needed):  ${partialGroups.length}`);
  console.log(`Already fully assigned (skipped):      ${skippedFullyAssigned}\n`);

  // ── Create new families ───────────────────────────────────────────────────
  let familiesCreated = 0;
  let studentsAssigned = 0;

  for (let i = 0; i < toCreate.length; i++) {
    const group = toCreate[i];

    const family = await prisma.families.create({
      data: {
        household_name: group.householdName,
        email: null,
        password_hash: null,
      },
    });

    await prisma.students.updateMany({
      where: { cc: { in: group.newStudents } },
      data: { family_id: family.id },
    });

    familiesCreated++;
    studentsAssigned += group.newStudents.length;

    process.stdout.write(`\r  Families created: ${familiesCreated}/${toCreate.length}...`);
  }
  console.log('');

  // ── Hard-coded fix: ZAHRA (CC=7717) → family 2629 ────────────────────────
  await prisma.students.update({
    where: { cc: 7717 },
    data: { family_id: 2629 },
  });
  console.log('Assigned CC=7717 ZAHRA to existing family fam_id=2629 (NAZIM ALI).');
  studentsAssigned++;

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('COMPLETE');
  console.log('══════════════════════════════════════════════════════');
  console.log(`New families created:     ${familiesCreated}`);
  console.log(`Students assigned:        ${studentsAssigned}`);
  console.log(`  (incl. 1 partial merge: ZAHRA → fam 2629)`);
}

main()
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
