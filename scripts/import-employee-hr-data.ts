/**
 * import-employee-hr-data.ts
 *
 * Loads the cleaned HR intake sheets into the live database:
 *   1. Refreshes `designations` — clears it and inserts the unique
 *      "Designation" values from EmployeeData.cleaned.csv (department_id
 *      left null; departments table is empty right now).
 *   2. Refreshes `staff_types` — clears the 4 placeholder rows
 *      (domestic/old_admin/new_admin/teacher) and inserts the unique
 *      "Staff Type" values from Attendance&Pay.cleaned.csv (which HR
 *      actually filled with role/subject text, not the original enum).
 *   3. Upserts `employee_profiles` for all 85 employees (matched by
 *      employee_code across both sheets), wiring up designation_id,
 *      staff_type_id, campus_id (Johar C-II/III/IV and TAFSAL all map to
 *      campus_id 1 per instruction), and every other clean field.
 *   4. Parses the "Class–Section Assignment" column into
 *      employee_class_section_assignments rows, but ONLY where a class and
 *      an explicit section letter (A-D) are both unambiguous (e.g. "KG A",
 *      "NUR-B", "NUR A,B & C"). Anything without an explicit section,
 *      anything that's just a duplicate of the Staff Type/Designation text,
 *      or anything garbled is left unassigned and logged instead of guessed.
 *
 * DRY_RUN=true by default — prints what would change without writing.
 * Set DRY_RUN=false to actually commit.
 *
 * Usage:
 *   npx ts-node scripts/import-employee-hr-data.ts          (dry run)
 *   DRY_RUN=false npx ts-node scripts/import-employee-hr-data.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const OUT_DIR = path.join(__dirname, '..', 'staff-data', 'cleaned');

const prisma = new PrismaClient();

const SECTION_IDS: Record<string, number> = { A: 1, B: 2, C: 3, D: 4 };

// Matches the `classes` table exactly (id -> class_code), used for parsing
// "Class–Section Assignment" text into class_id + section_id pairs.
const CLASS_CODES: { id: number; code: string }[] = [
  { id: 1, code: 'PN' },
  { id: 2, code: 'NUR' },
  { id: 3, code: 'KG' },
  { id: 4, code: 'JRI' },
  { id: 5, code: 'JRII' },
  { id: 6, code: 'JRIII' },
  { id: 7, code: 'JRIV' },
  { id: 8, code: 'JRV' },
  { id: 9, code: 'SRI' },
  { id: 10, code: 'SRII' },
  { id: 11, code: 'SRIII' },
  { id: 12, code: 'OI' },
  { id: 13, code: 'OII' },
  { id: 14, code: 'OIII' },
  { id: 15, code: 'VI' },
  { id: 16, code: 'VII' },
  { id: 17, code: 'VIII' },
  { id: 18, code: 'IX' },
  { id: 19, code: 'X' },
  { id: 21, code: 'AS' },
  { id: 22, code: 'A2' },
].sort((a, b) => b.code.length - a.code.length); // longest code first to avoid prefix collisions

interface ParsedAssignment {
  classId: number;
  sectionIds: number[];
}

/** Parses a Class–Section Assignment cell into confident class+section pairs only. Returns null if ambiguous/unparseable. */
function parseClassSection(raw: string): ParsedAssignment | null {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9,&]/g, '');
  if (!compact) return null;

  for (const cls of CLASS_CODES) {
    if (!compact.startsWith(cls.code)) continue;
    const rest = compact.slice(cls.code.length).replace(/[,&]/g, '');
    if (!rest) return null; // class mentioned but no section letter given -> ambiguous
    const letters = rest.split('');
    if (letters.every((l) => l in SECTION_IDS)) {
      const sectionIds = [...new Set(letters.map((l) => SECTION_IDS[l]))];
      return { classId: cls.id, sectionIds };
    }
    return null; // suffix isn't clean section letters -> ambiguous/garbled
  }
  return null; // doesn't start with any known class code
}

function toTime(value: string): Date | null {
  if (!value) return null;
  return new Date(`1970-01-01T${value}:00Z`);
}

function toDateDDMMYYYY(value: string): Date | null {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
}

function isValidCnic(value: string): boolean {
  return /^\d{5}-\d{7}-\d$/.test(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

async function main() {
  const employeeRows = parse(fs.readFileSync(path.join(OUT_DIR, 'EmployeeData.cleaned.csv'), 'utf8'), {
    skip_empty_lines: false,
  }).slice(2).filter((r: string[]) => r[0]?.trim());

  const attendancePayRows = parse(fs.readFileSync(path.join(OUT_DIR, 'Attendance&Pay.cleaned.csv'), 'utf8'), {
    skip_empty_lines: false,
  }).slice(2).filter((r: string[]) => r[0]?.trim());

  const apByCode = new Map<string, string[]>();
  for (const row of attendancePayRows) apByCode.set(row[0].trim().toUpperCase(), row);

  // ---- 0. Detect CNICs shared by more than one employee (data error, not --
  // ---- something we can resolve by guessing) -------------------------------
  const cnicCounts = new Map<string, string[]>();
  for (const row of employeeRows) {
    const cnic = row[6]?.trim();
    if (!cnic || !isValidCnic(cnic)) continue;
    cnicCounts.set(cnic, [...(cnicCounts.get(cnic) ?? []), row[0].trim()]);
  }
  const duplicateCnics = new Set(
    [...cnicCounts.entries()].filter(([, codes]) => codes.length > 1).map(([cnic]) => cnic)
  );

  // ---- 1. Designations ----------------------------------------------------
  const uniqueDesignations = [...new Set(employeeRows.map((r: string[]) => r[1].trim()).filter(Boolean))];
  console.log(`Designations: ${uniqueDesignations.length} unique values to load.`);

  // ---- 2. Staff types -------------------------------------------------------
  const uniqueStaffTypes = [...new Set(attendancePayRows.map((r: string[]) => r[6].trim()).filter(Boolean))];
  console.log(`Staff types: ${uniqueStaffTypes.length} unique values to load.`);

  // ---- 3. Parse class-section assignments + collect review notes ----------
  const reviewNotes: string[] = [];
  const assignmentsByCode = new Map<string, ParsedAssignment[]>();

  for (const row of employeeRows) {
    const code = row[0].trim();
    const apRow = apByCode.get(code.toUpperCase());
    if (!apRow) continue;
    const staffTypeText = apRow[6].trim();
    const classSectionText = apRow[8].trim();
    if (!classSectionText) continue;

    if (classSectionText === staffTypeText) {
      reviewNotes.push(`[Class-Section] ${code}: value is identical to Staff Type ("${staffTypeText}") — not a real class assignment, left unassigned.`);
      continue;
    }

    const segments = classSectionText.split(/\s*[;]\s*/); // support "6:A,B;7:A,C"-style separators too
    const parsed: ParsedAssignment[] = [];
    let allOk = true;
    for (const segment of segments) {
      const result = parseClassSection(segment);
      if (!result) {
        allOk = false;
        break;
      }
      parsed.push(result);
    }

    if (allOk && parsed.length) {
      assignmentsByCode.set(code.toUpperCase(), parsed);
    } else {
      reviewNotes.push(`[Class-Section] ${code}: "${classSectionText}" could not be parsed into class:section pairs (no explicit section letter, or garbled) — left unassigned, needs HR clarification.`);
    }
  }

  for (const [cnic, codes] of cnicCounts) {
    if (codes.length > 1) {
      reviewNotes.push(`[CNIC] ${codes.join(' & ')}: share the same CNIC "${cnic}" — cannot belong to both, cleared on both records, needs HR correction.`);
    }
  }

  console.log(`Class-section assignments confidently parsed for ${assignmentsByCode.size} employees.`);
  console.log(`${reviewNotes.length} class-section entries flagged for review.`);
  if (duplicateCnics.size) console.log(`${duplicateCnics.size} duplicate CNIC(s) found and cleared — see review notes.`);

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: no changes written. Sample of what would happen: ---');
    console.log('Designations:', uniqueDesignations.slice(0, 5), '...');
    console.log('Staff types:', uniqueStaffTypes.slice(0, 5), '...');
    console.log('Sample parsed assignments:', [...assignmentsByCode.entries()].slice(0, 5));
    console.log('\nReview notes:');
    reviewNotes.forEach((n) => console.log(' -', n));
    await prisma.$disconnect();
    return;
  }

  // ---- Write phase ----------------------------------------------------------

  // Detach the FK before clearing old lookup rows.
  await prisma.employee_profiles.updateMany({ data: { staff_type_id: null }, where: {} });
  await prisma.staff_types.deleteMany({});
  await prisma.designations.deleteMany({});

  const designationIdByTitle = new Map<string, number>();
  for (const title of uniqueDesignations) {
    const created = await prisma.designations.create({ data: { title, department_id: null } });
    designationIdByTitle.set(title, created.id);
  }

  const staffTypeIdByName = new Map<string, number>();
  for (const name of uniqueStaffTypes) {
    const created = await prisma.staff_types.create({
      data: { code: slugify(name) || `staff_type_${staffTypeIdByName.size + 1}`, name },
    });
    staffTypeIdByName.set(name, created.id);
  }

  let created = 0;
  let updated = 0;

  for (const row of employeeRows) {
    const [
      employeeCode, designation, fullName, fatherName, motherName,
      dateOfJoining, cnic, dob, address, phone, email, jobTitle, jobDescription, notes,
    ] = row;

    const apRow = apByCode.get(employeeCode.trim().toUpperCase());

    const data = {
      employee_code: employeeCode || null,
      full_name: fullName || null,
      father_name: fatherName || null,
      mother_name: motherName || null,
      join_date: dateOfJoining ? toDateDDMMYYYY(dateOfJoining) : null,
      cnic: cnic && isValidCnic(cnic) && !duplicateCnics.has(cnic) ? cnic : null,
      date_of_birth: dob ? toDateDDMMYYYY(dob) : null,
      address: address || null,
      personal_phone: phone || null,
      personal_email: email || null,
      job_title: jobTitle || null,
      job_description: jobDescription || null,
      notes: notes || null,
      designation_id: designation ? designationIdByTitle.get(designation) ?? null : null,
      campus_id: apRow ? 1 : null, // Johar C-II/III/IV and TAFSAL all map to campus_id 1
      staff_type_id: apRow ? staffTypeIdByName.get(apRow[6].trim()) ?? null : null,
      reporting_time: apRow ? toTime(apRow[2]) : null,
      leaving_time: apRow ? toTime(apRow[3]) : null,
      late_relaxation_minutes: apRow && apRow[4] ? parseInt(apRow[4], 10) : null,
      monthly_pay: apRow && apRow[5] ? apRow[5] : null,
      days_per_week: apRow && apRow[9] ? parseInt(apRow[9], 10) : null,
    };

    const existing = await prisma.employee_profiles.findFirst({ where: { employee_code: employeeCode } });
    const employee = existing
      ? await prisma.employee_profiles.update({ where: { id: existing.id }, data })
      : await prisma.employee_profiles.create({ data });

    if (existing) updated++;
    else created++;

    const assignments = assignmentsByCode.get(employeeCode.trim().toUpperCase());
    await prisma.employee_class_section_assignments.deleteMany({ where: { employee_id: employee.id } });
    if (assignments?.length) {
      for (const a of assignments) {
        for (const sectionId of a.sectionIds) {
          await prisma.employee_class_section_assignments.create({
            data: { employee_id: employee.id, class_id: a.classId, section_id: sectionId },
          });
        }
      }
    }
  }

  console.log(`\nDesignations loaded: ${designationIdByTitle.size}`);
  console.log(`Staff types loaded: ${staffTypeIdByName.size}`);
  console.log(`Employee profiles created: ${created}, updated: ${updated}`);

  const reportPath = path.join(OUT_DIR, 'review-needed.txt');
  const existingNotes = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8').trimEnd() : '';
  const baseNotes = existingNotes && existingNotes !== 'No format issues required manual review.' ? existingNotes.split('\n') : [];
  fs.writeFileSync(reportPath, [...baseNotes, ...reviewNotes].join('\n') + '\n', 'utf8');
  console.log(`${reviewNotes.length} class-section review notes appended -> ${reportPath}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
