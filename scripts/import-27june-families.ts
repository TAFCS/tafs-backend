/**
 * import-27june-families.ts
 *
 * Processes fathers-data/27june.csv:
 *  - Students already in a family → skip
 *  - Students with a valid father CNIC that maps to an existing family
 *    (via an already-linked sibling) → join that family
 *  - Students with a valid father CNIC and no existing family → create new family,
 *    group all siblings with the same CNIC together
 *  - Students with no valid father CNIC → left without family, noted in review CSV
 *
 * Outputs: fathers-data/27june-review.csv
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const CNIC_RE = /^\d{5}-\d{7}-\d{1}$/;

function isValidCnic(v: string | null | undefined): boolean {
  if (!v?.trim()) return false;
  return CNIC_RE.test(v.trim());
}

function cell(v: unknown): string {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const values = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] ?? '').trim(); });
    if (!row['student_cc'] || row['student_cc'] === '') continue;
    rows.push(row);
  }
  return rows;
}

interface StudentRow {
  cc: number;
  fullName: string;
  fatherName: string;
  fatherCnic: string;
  class: string;
  campusId: number;
}

interface ReviewRow {
  student_cc: number;
  full_name: string;
  class: string;
  campus_id: number;
  father_name: string;
  father_cnic: string;
  action: string;
  family_id: string;
  notes: string;
}

async function main() {
  const csvPath = path.join(__dirname, '..', 'fathers-data', '27june.csv');
  const content = fs.readFileSync(csvPath, 'utf8');
  const rawRows = parseCSV(content);

  const csvStudents: StudentRow[] = rawRows
    .map(r => ({
      cc: parseInt(r['student_cc']),
      fullName: r['full_name'] ?? '',
      fatherName: r['father_name'] ?? '',
      fatherCnic: r['father_cnic'] ?? '',
      class: r['class'] ?? '',
      campusId: parseInt(r['campus_id']) || 0,
    }))
    .filter(r => !isNaN(r.cc));

  console.log(`CSV rows parsed: ${csvStudents.length}\n`);

  // ── DB lookups ──────────────────────────────────────────────────────────────
  const ccs = csvStudents.map(s => s.cc);
  const dbStudents = await prisma.students.findMany({
    where: { cc: { in: ccs } },
    select: { cc: true, full_name: true, family_id: true },
  });
  const studentMap = new Map(dbStudents.map(s => [s.cc, s]));
  console.log(`Students found in DB: ${dbStudents.length}/${csvStudents.length}`);

  // Find existing guardians for valid CNICs
  const validCnics = [...new Set(csvStudents.map(s => s.fatherCnic).filter(isValidCnic))];
  const existingGuardians = await prisma.guardians.findMany({
    where: { cnic: { in: validCnics } },
    select: { id: true, cnic: true, full_name: true },
  });
  const guardianByCnic = new Map(existingGuardians.map(g => [g.cnic!, g]));
  console.log(`Valid CNICs in CSV: ${validCnics.length} | Already in guardians table: ${existingGuardians.length}`);

  // For existing guardians, find any linked student that has a family_id
  const guardianFamilyMap = new Map<number, number>(); // guardian_id → family_id
  if (existingGuardians.length > 0) {
    const links = await prisma.student_guardians.findMany({
      where: { guardian_id: { in: existingGuardians.map(g => g.id) } },
      include: { students: { select: { family_id: true } } },
    });
    for (const link of links) {
      if (link.students.family_id != null && !guardianFamilyMap.has(link.guardian_id)) {
        guardianFamilyMap.set(link.guardian_id, link.students.family_id);
      }
    }
  }

  // ── Group CSV students by father CNIC ───────────────────────────────────────
  const byCnic = new Map<string, StudentRow[]>();
  const noValidCnicStudents: StudentRow[] = [];

  for (const s of csvStudents) {
    if (!isValidCnic(s.fatherCnic)) {
      noValidCnicStudents.push(s);
    } else {
      if (!byCnic.has(s.fatherCnic)) byCnic.set(s.fatherCnic, []);
      byCnic.get(s.fatherCnic)!.push(s);
    }
  }
  console.log(`CNIC groups to process: ${byCnic.size} | No/invalid CNIC: ${noValidCnicStudents.length}\n`);

  // ── Process each CNIC group ─────────────────────────────────────────────────
  const reviewRows: ReviewRow[] = [];
  let newFamiliesCreated = 0;
  let studentsAddedToNewFamily = 0;
  let studentsJoinedExisting = 0;
  let studentsAlreadyInFamily = 0;
  let studentsSkippedNoCnic = 0;
  let studentsNotInDb = 0;

  for (const [cnic, students] of byCnic.entries()) {
    const guardian = guardianByCnic.get(cnic);
    const needFamily: StudentRow[] = [];
    let groupExistingFamilyId: number | null = null;

    for (const s of students) {
      const dbS = studentMap.get(s.cc);
      if (!dbS) {
        reviewRows.push({ student_cc: s.cc, full_name: s.fullName, class: s.class, campus_id: s.campusId, father_name: s.fatherName, father_cnic: cnic, action: 'SKIPPED_NOT_IN_DB', family_id: '', notes: 'Student CC not found in database' });
        studentsNotInDb++;
        continue;
      }
      if (dbS.family_id != null) {
        if (groupExistingFamilyId == null) groupExistingFamilyId = dbS.family_id;
        reviewRows.push({ student_cc: s.cc, full_name: s.fullName, class: s.class, campus_id: s.campusId, father_name: s.fatherName, father_cnic: cnic, action: 'ALREADY_IN_FAMILY', family_id: String(dbS.family_id), notes: '' });
        studentsAlreadyInFamily++;
      } else {
        needFamily.push(s);
      }
    }

    if (needFamily.length === 0) continue;

    // Resolve existing family: from a sibling in the same CSV group, or from guardian's existing DB links
    let existingFamilyId = groupExistingFamilyId;
    if (existingFamilyId == null && guardian) {
      existingFamilyId = guardianFamilyMap.get(guardian.id) ?? null;
    }

    // Upsert guardian (create if missing, don't overwrite name if already exists)
    const g = await prisma.guardians.upsert({
      where: { cnic },
      create: { cnic, full_name: needFamily[0].fatherName || null },
      update: {},
    });

    if (existingFamilyId != null) {
      // Join existing family
      await prisma.students.updateMany({
        where: { cc: { in: needFamily.map(s => s.cc) } },
        data: { family_id: existingFamilyId },
      });
      await prisma.student_guardians.createMany({
        data: needFamily.map(s => ({
          student_id: s.cc,
          guardian_id: g.id,
          relationship: 'Father',
          is_primary_contact: true,
          is_emergency_contact: true,
        })),
        skipDuplicates: true,
      });
      for (const s of needFamily) {
        reviewRows.push({ student_cc: s.cc, full_name: s.fullName, class: s.class, campus_id: s.campusId, father_name: s.fatherName, father_cnic: cnic, action: 'JOINED_EXISTING_FAMILY', family_id: String(existingFamilyId), notes: '' });
        studentsJoinedExisting++;
      }
    } else {
      // Create new family
      const family = await prisma.families.create({
        data: { household_name: needFamily[0].fatherName || 'Unknown', email: null, password_hash: null },
      });
      await prisma.students.updateMany({
        where: { cc: { in: needFamily.map(s => s.cc) } },
        data: { family_id: family.id },
      });
      await prisma.student_guardians.createMany({
        data: needFamily.map(s => ({
          student_id: s.cc,
          guardian_id: g.id,
          relationship: 'Father',
          is_primary_contact: true,
          is_emergency_contact: true,
        })),
        skipDuplicates: true,
      });
      for (const s of needFamily) {
        reviewRows.push({ student_cc: s.cc, full_name: s.fullName, class: s.class, campus_id: s.campusId, father_name: s.fatherName, father_cnic: cnic, action: 'NEW_FAMILY_CREATED', family_id: String(family.id), notes: '' });
        studentsAddedToNewFamily++;
      }
      newFamiliesCreated++;
    }

    process.stdout.write(`\r  ${newFamiliesCreated} new families | ${studentsJoinedExisting} joined existing | ${studentsAlreadyInFamily} already set...`);
  }

  // ── Students with no valid CNIC ─────────────────────────────────────────────
  for (const s of noValidCnicStudents) {
    const dbS = studentMap.get(s.cc);
    if (!dbS) {
      reviewRows.push({ student_cc: s.cc, full_name: s.fullName, class: s.class, campus_id: s.campusId, father_name: s.fatherName, father_cnic: s.fatherCnic, action: 'SKIPPED_NOT_IN_DB', family_id: '', notes: 'Student CC not found in database' });
      studentsNotInDb++;
    } else if (dbS.family_id != null) {
      reviewRows.push({ student_cc: s.cc, full_name: s.fullName, class: s.class, campus_id: s.campusId, father_name: s.fatherName, father_cnic: s.fatherCnic, action: 'ALREADY_IN_FAMILY', family_id: String(dbS.family_id), notes: 'No valid father CNIC but already in a family' });
      studentsAlreadyInFamily++;
    } else {
      reviewRows.push({ student_cc: s.cc, full_name: s.fullName, class: s.class, campus_id: s.campusId, father_name: s.fatherName, father_cnic: s.fatherCnic, action: 'LEFT_WITHOUT_FAMILY', family_id: '', notes: `Invalid/missing father CNIC: "${s.fatherCnic}"` });
      studentsSkippedNoCnic++;
    }
  }

  // ── Write review CSV ────────────────────────────────────────────────────────
  console.log('\n');
  const headers: (keyof ReviewRow)[] = ['student_cc', 'full_name', 'class', 'campus_id', 'father_name', 'father_cnic', 'action', 'family_id', 'notes'];
  const csvOut = [
    headers.map(cell).join(','),
    ...reviewRows.sort((a, b) => a.student_cc - b.student_cc).map(r => headers.map(h => cell(r[h])).join(',')),
  ].join('\r\n') + '\r\n';

  const outPath = path.join(__dirname, '..', 'fathers-data', '27june-review.csv');
  fs.writeFileSync(outPath, csvOut, 'utf8');

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════');
  console.log(`Total CSV students:           ${csvStudents.length}`);
  console.log(`  Already in a family:        ${studentsAlreadyInFamily}`);
  console.log(`  Joined existing family:     ${studentsJoinedExisting}`);
  console.log(`  Added to new family:        ${studentsAddedToNewFamily}`);
  console.log(`  Left without family:        ${studentsSkippedNoCnic}  (no valid CNIC)`);
  console.log(`  Not found in DB:            ${studentsNotInDb}`);
  console.log(`New families created:         ${newFamiliesCreated}`);
  console.log(`Review CSV → ${outPath}`);
}

main()
  .catch(e => { console.error('Fatal:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
