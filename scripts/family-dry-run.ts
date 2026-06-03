/**
 * family-dry-run.ts
 *
 * Part A — CSV export:
 *   Writes fathers-data/students_no_guardian.csv listing every active student
 *   that has zero rows in student_guardians.
 *
 * Part B — Family creation dry run:
 *   Groups students by their father guardian's CNIC (primary grouping key).
 *   Students with no father link but a valid mother link are grouped by mother CNIC.
 *   - household_name = guardian full_name
 *   - email = null, password_hash = null
 *   Prints a per-family breakdown and final counts.
 *   Nothing is written to the DB.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/family-dry-run.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

// ─── CSV helper ───────────────────────────────────────────────────────────────

function csvCell(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function toCSV<T extends object>(rows: T[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0] as object);
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((r) =>
      headers
        .map((h) => csvCell(String((r as Record<string, unknown>)[h] ?? '')))
        .join(','),
    ),
  ];
  return lines.join('\r\n') + '\r\n';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══ FAMILY DRY RUN ═══\n');

  // ── Fetch active students ─────────────────────────────────────────────────
  const students = await prisma.students.findMany({
    where: { deleted_at: null },
    select: {
      cc: true,
      gr_number: true,
      full_name: true,
      family_id: true,
      campus_id: true,
      classes: { select: { description: true } },
    },
  });
  console.log(`Active students in DB: ${students.length}`);

  const studentMap = new Map(students.map((s) => [s.cc, s]));

  // ── Fetch all student_guardian links ──────────────────────────────────────
  const allLinks = await prisma.student_guardians.findMany({
    select: { student_id: true, guardian_id: true, relationship: true },
  });

  const studentsWithGuardian = new Set(allLinks.map((l) => l.student_id));

  // ══════════════════════════════════════════════════════════════════════════
  // PART A — Students with no guardian link
  // ══════════════════════════════════════════════════════════════════════════

  const noGuardianStudents = students.filter((s) => !studentsWithGuardian.has(s.cc));
  console.log(`Students with no guardian link at all: ${noGuardianStudents.length}`);

  const noGuardianRows = noGuardianStudents.map((s) => ({
    student_cc: String(s.cc),
    gr_number: s.gr_number ?? '',
    full_name: s.full_name,
    class: s.classes?.description ?? '',
    campus_id: String(s.campus_id ?? ''),
    current_family_id: String(s.family_id ?? ''),
  }));

  const noGuardianPath = path.join(
    __dirname,
    '..',
    'fathers-data',
    'students_no_guardian.csv',
  );
  fs.writeFileSync(noGuardianPath, toCSV(noGuardianRows), 'utf8');
  console.log(`Wrote students_no_guardian.csv → ${noGuardianPath}\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART B — Family grouping dry run
  // ══════════════════════════════════════════════════════════════════════════

  // Fetch guardians
  const guardianIds = [...new Set(allLinks.map((l) => l.guardian_id))];
  const guardians = await prisma.guardians.findMany({
    where: { id: { in: guardianIds } },
    select: { id: true, cnic: true, full_name: true },
  });
  const guardianMap = new Map(guardians.map((g) => [g.id, g]));

  // Build per-student guardian index
  type StudentGuardianIndex = { fatherId?: number; motherId?: number };
  const studentGuardianIndex = new Map<number, StudentGuardianIndex>();
  for (const link of allLinks) {
    const rel = link.relationship.toLowerCase();
    if (!studentGuardianIndex.has(link.student_id)) {
      studentGuardianIndex.set(link.student_id, {});
    }
    const entry = studentGuardianIndex.get(link.student_id)!;
    if (rel === 'father') entry.fatherId = link.guardian_id;
    if (rel === 'mother') entry.motherId = link.guardian_id;
  }

  // ── Group students into family buckets ────────────────────────────────────
  type FamilyGroup = {
    groupingKey: string;
    primaryGuardianId: number;
    householdName: string;
    cnic: string;
    relationship: 'Father' | 'Mother';
    studentCCs: number[];
    studentsAlreadyInFamily: number[];
    newStudents: number[];
  };

  const familyGroups = new Map<string, FamilyGroup>();

  for (const [cc, guardianInfo] of studentGuardianIndex.entries()) {
    let key: string;
    let guardianId: number;
    let rel: 'Father' | 'Mother';

    if (guardianInfo.fatherId !== undefined) {
      const g = guardianMap.get(guardianInfo.fatherId);
      if (!g?.cnic) continue; // no CNIC — can't group reliably
      key = `F:${g.cnic}`;
      guardianId = guardianInfo.fatherId;
      rel = 'Father';
    } else {
      // No father CNIC — skip (father-only grouping)
      continue;
    }

    if (!familyGroups.has(key)) {
      const g = guardianMap.get(guardianId)!;
      familyGroups.set(key, {
        groupingKey: key,
        primaryGuardianId: guardianId,
        householdName: g.full_name || 'Unknown Household',
        cnic: g.cnic!,
        relationship: rel,
        studentCCs: [],
        studentsAlreadyInFamily: [],
        newStudents: [],
      });
    }

    const group = familyGroups.get(key)!;
    group.studentCCs.push(cc);

    const student = studentMap.get(cc);
    if (student?.family_id != null) {
      group.studentsAlreadyInFamily.push(cc);
    } else {
      group.newStudents.push(cc);
    }
  }

  // ── Classify groups ───────────────────────────────────────────────────────
  const newFamilyGroups: FamilyGroup[] = [];     // all students unassigned
  const partialGroups: FamilyGroup[] = [];       // some assigned, some not
  const allAssignedGroups: FamilyGroup[] = [];   // all students already assigned

  for (const group of familyGroups.values()) {
    if (group.studentsAlreadyInFamily.length === 0) {
      newFamilyGroups.push(group);
    } else if (group.newStudents.length > 0) {
      partialGroups.push(group);
    } else {
      allAssignedGroups.push(group);
    }
  }

  // ── Student label helper ──────────────────────────────────────────────────
  function studentLabel(cc: number): string {
    const s = studentMap.get(cc);
    const cls = s?.classes?.description ?? '?';
    return `CC=${cc}  ${s?.full_name ?? '?'}  [${cls}]${s?.family_id ? `  (already fam_id=${s.family_id})` : ''}`;
  }

  // ── Print new families ────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════');
  console.log('FAMILY GROUPING DRY RUN — RESULTS');
  console.log('══════════════════════════════════════════════════════\n');

  console.log(`─── NEW FAMILIES TO CREATE (father CNIC only): ${newFamilyGroups.length} ───`);
  for (const g of newFamilyGroups) {
    console.log(
      `\n  "${g.householdName}"  CNIC=${g.cnic}  → ${g.studentCCs.length} student(s)`,
    );
    for (const cc of g.studentCCs) {
      console.log(`      ${studentLabel(cc)}`);
    }
  }

  // ── Print partial groups ──────────────────────────────────────────────────
  if (partialGroups.length > 0) {
    console.log(`\n─── PARTIAL GROUPS (some students already assigned to a family): ${partialGroups.length} ───`);
    console.log('    These families would need the unassigned students added to the existing family.\n');
    for (const g of partialGroups) {
      console.log(
        `  "${g.householdName}"  CNIC=${g.cnic}  → ${g.studentCCs.length} student(s)`,
      );
      for (const cc of g.studentCCs) {
        console.log(`      ${studentLabel(cc)}`);
      }
    }
  }

  // ── Print already fully assigned (compact) ────────────────────────────────
  console.log(`\n─── ALREADY FULLY ASSIGNED (no action needed): ${allAssignedGroups.length} groups ───`);

  // ── Counts ────────────────────────────────────────────────────────────────
  const studentsInNewFamilies = newFamilyGroups.reduce((s, g) => s + g.studentCCs.length, 0);
  const studentsInPartialNew = partialGroups.reduce((s, g) => s + g.newStudents.length, 0);
  const studentsSkipped =
    students.filter((s) => !studentsWithGuardian.has(s.cc)).length;
  const studentsNoGroupableCnic = [...studentGuardianIndex.keys()].filter(
    (cc) => {
      const info = studentGuardianIndex.get(cc)!;
      const fCnic = info.fatherId ? guardianMap.get(info.fatherId)?.cnic : null;
      const mCnic = info.motherId ? guardianMap.get(info.motherId)?.cnic : null;
      return !fCnic && !mCnic;
    },
  ).length;

  console.log('\n══════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('══════════════════════════════════════════════════════');
  console.log(`Active students total:                         ${students.length}`);
  console.log(`  No guardian at all (CSV exported):           ${studentsSkipped}`);
  console.log(`  Guardian exists but no groupable CNIC:       ${studentsNoGroupableCnic}`);
  console.log('');
  console.log(`Families to CREATE (all students unassigned):  ${newFamilyGroups.length}`);
  console.log(`  └─ Students that would be assigned:          ${studentsInNewFamilies}`);
  console.log('');
  console.log(`Partial groups (need merging, not new):        ${partialGroups.length}`);
  console.log(`  └─ Unassigned students in partial groups:    ${studentsInPartialNew}`);
  console.log('');
  console.log(`Already fully assigned groups:                 ${allAssignedGroups.length}`);
  console.log('');
  console.log('No DB writes were made — this is a dry run only.');
  console.log(`CSV written: ${noGuardianPath}`);
}

main()
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
