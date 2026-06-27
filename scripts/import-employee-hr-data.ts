/**
 * import-employee-hr-data.ts
 *
 * Loads cleaned HR intake sheets into the database:
 *   1. Seeds 5 reference departments (ALL CAPS) from message.txt
 *   2. Upserts employee_profiles for all employees (matched by employee_code)
 *   3. Maps role / staff_category / department via staff-org-mapping.ts
 *   4. Parses class-section assignments where unambiguous
 *   5. Creates users accounts (role EMPLOYEE) and writes credentials CSV
 *
 * DRY_RUN=true by default — prints what would change without writing.
 * Set DRY_RUN=false to actually commit.
 *
 * Usage:
 *   npx ts-node scripts/import-employee-hr-data.ts
 *   DRY_RUN=false npx ts-node scripts/import-employee-hr-data.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { PrismaClient, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { DEPARTMENT_SEED, resolveStaffOrg } from './staff-org-mapping';
import {
  getManualClassSectionOverride,
  isNoClassAssignmentExpected,
} from './staff-class-section-overrides';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const OUT_DIR = path.join(__dirname, '..', 'staff-data', 'cleaned');
const CREDENTIALS_PATH = path.join(OUT_DIR, 'employee-credentials.csv');

const prisma = new PrismaClient();

const SECTION_IDS: Record<string, number> = { A: 1, B: 2, C: 3, D: 4 };

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
].sort((a, b) => b.code.length - a.code.length);

interface ParsedAssignment {
  classId: number;
  sectionIds: number[];
}

function resolveClassSectionAssignments(
  code: string,
  staffTypeText: string,
  classSectionText: string,
): { assignments: ParsedAssignment[] | null; reviewNote: string | null } {
  const manual = getManualClassSectionOverride(code);
  if (manual) {
    return { assignments: manual, reviewNote: null };
  }

  if (!classSectionText) {
    return { assignments: null, reviewNote: null };
  }

  if (isNoClassAssignmentExpected(code)) {
    return { assignments: null, reviewNote: null };
  }

  if (classSectionText === staffTypeText) {
    return {
      assignments: null,
      reviewNote: `[Class-Section] ${code}: value is identical to Staff Type ("${staffTypeText}") — left unassigned.`,
    };
  }

  const segments = classSectionText.split(/\s*[;]\s*/);
  const parsed: ParsedAssignment[] = [];
  for (const segment of segments) {
    const result = parseClassSection(segment);
    if (!result) {
      return {
        assignments: null,
        reviewNote: `[Class-Section] ${code}: "${classSectionText}" could not be parsed — left unassigned.`,
      };
    }
    parsed.push(result);
  }

  return { assignments: parsed.length ? parsed : null, reviewNote: null };
}

function parseClassSection(raw: string): ParsedAssignment | null {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9,&]/g, '');
  if (!compact) return null;

  for (const cls of CLASS_CODES) {
    if (!compact.startsWith(cls.code)) continue;
    const rest = compact.slice(cls.code.length).replace(/[,&]/g, '');
    if (!rest) return null;
    const letters = rest.split('');
    if (letters.every((l) => l in SECTION_IDS)) {
      const sectionIds = [...new Set(letters.map((l) => SECTION_IDS[l]))];
      return { classId: cls.id, sectionIds };
    }
    return null;
  }
  return null;
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

function generatePassword(): string {
  return randomBytes(9).toString('base64url').slice(0, 12);
}

const HONORIFIC_PREFIX = /^(MR\.?|MRS\.?|MS\.?|M\.)\s*/i;

function buildUsername(fullName: string, employeeCode: string, taken: Set<string>): string {
  let name = fullName.trim().replace(HONORIFIC_PREFIX, '').trim();
  name = name.replace(/\s*-\s*/g, ' ');
  const tokens = name.split(/\s+/).filter(Boolean);

  let base: string;
  if (tokens.length >= 2) {
    const first = tokens[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const last = tokens[tokens.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
    base = `${first}.${last}`;
  } else if (tokens.length === 1) {
    base = tokens[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  } else {
    base = 'employee';
  }

  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  const suffix = employeeCode.replace(/\D/g, '').slice(-4) || String(taken.size);
  const withSuffix = `${base}.${suffix}`;
  taken.add(withSuffix);
  return withSuffix;
}

async function seedDepartments(): Promise<Map<string, number>> {
  const idByName = new Map<string, number>();
  for (const dept of DEPARTMENT_SEED) {
    const existing = await prisma.departments.findFirst({ where: { name: dept.name } });
    const row = existing
      ? await prisma.departments.update({
          where: { id: existing.id },
          data: { description: dept.description },
        })
      : await prisma.departments.create({
          data: { name: dept.name, description: dept.description },
        });
    idByName.set(dept.name, row.id);
  }
  return idByName;
}

async function main() {
  const employeeRows = parse(
    fs.readFileSync(path.join(OUT_DIR, 'EmployeeData.cleaned.csv'), 'utf8'),
    { skip_empty_lines: false },
  ).slice(2).filter((r: string[]) => r[0]?.trim()) as string[][];

  const attendancePayRows = parse(
    fs.readFileSync(path.join(OUT_DIR, 'Attendance&Pay.cleaned.csv'), 'utf8'),
    { skip_empty_lines: false },
  ).slice(2).filter((r: string[]) => r[0]?.trim()) as string[][];

  const apByCode = new Map<string, string[]>();
  for (const row of attendancePayRows) apByCode.set(row[0].trim().toUpperCase(), row);

  const cnicCounts = new Map<string, string[]>();
  for (const row of employeeRows) {
    const cnic = row[6]?.trim();
    if (!cnic || !isValidCnic(cnic)) continue;
    cnicCounts.set(cnic, [...(cnicCounts.get(cnic) ?? []), row[0].trim()]);
  }
  const duplicateCnics = new Set(
    [...cnicCounts.entries()].filter(([, codes]) => codes.length > 1).map(([cnic]) => cnic),
  );

  const reviewNotes: string[] = [];
  const assignmentsByCode = new Map<string, ParsedAssignment[]>();
  const orgPreview: { code: string; name: string; role: string | null; category: string | null; dept: string | null }[] = [];

  for (const row of employeeRows) {
    const code = row[0].trim();
    const apRow = apByCode.get(code.toUpperCase());
    if (!apRow) {
      reviewNotes.push(`[Attendance] ${code}: no matching Attendance&Pay row.`);
      continue;
    }

    const staffTypeText = apRow[6]?.trim() ?? '';
    const classSectionText = apRow[8]?.trim() ?? '';
    const { assignments, reviewNote } = resolveClassSectionAssignments(code, staffTypeText, classSectionText);
    if (assignments?.length) {
      assignmentsByCode.set(code.toUpperCase(), assignments);
    }
    if (reviewNote) {
      reviewNotes.push(reviewNote);
    }

    const { role, staffCategory, departmentName } = resolveStaffOrg(
      row[11]?.trim() || null,
      row[1]?.trim() || null,
      code,
    );
    orgPreview.push({
      code,
      name: row[2]?.trim() ?? '',
      role,
      category: staffCategory,
      dept: departmentName,
    });
    if (!role) {
      reviewNotes.push(`[Org] ${code} (${row[2]?.trim()}): could not resolve role from job title/designation.`);
    }
  }

  for (const [cnic, codes] of cnicCounts) {
    if (codes.length > 1) {
      reviewNotes.push(
        `[CNIC] ${codes.join(' & ')}: share CNIC "${cnic}" — cleared on both records. Confirm correct CNIC from each employee before updating.`,
      );
    }
  }

  console.log(`Employees to import: ${employeeRows.length}`);
  console.log(`Class-section assignments parsed: ${assignmentsByCode.size}`);
  console.log(`Review notes: ${reviewNotes.length}`);

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: no changes written ---');
    console.log('Sample org mapping:');
    orgPreview.slice(0, 8).forEach((p) =>
      console.log(`  ${p.code} | ${p.role ?? '?'} | ${p.category ?? '?'} | ${p.dept ?? '?'}`),
    );
    console.log('\nUsernames preview:');
    const taken = new Set<string>();
    employeeRows.slice(0, 8).forEach((row) => {
      console.log(`  ${buildUsername(row[2] ?? '', row[0] ?? '', taken)} <- ${row[2]}`);
    });
    if (reviewNotes.length) {
      console.log('\nReview notes:');
      reviewNotes.forEach((n) => console.log(' -', n));
    }
    await prisma.$disconnect();
    return;
  }

  const departmentIdByName = await seedDepartments();
  console.log(`Departments seeded: ${departmentIdByName.size}`);

  let created = 0;
  let updated = 0;
  const takenUsernames = new Set<string>();
  const credentials: { employee_code: string; full_name: string; username: string; password: string; role: string }[] = [];

  for (const row of employeeRows) {
    const [
      employeeCode, designation, fullName, fatherName, motherName,
      dateOfJoining, cnic, dob, address, phone, email, jobTitle, jobDescription, notes,
    ] = row;

    const apRow = apByCode.get(employeeCode.trim().toUpperCase());
    if (!apRow) continue;

    const { role, staffCategory, departmentName } = resolveStaffOrg(
      jobTitle?.trim() || null,
      designation?.trim() || null,
      employeeCode,
    );

    const profileData = {
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
      job_title: role,
      staff_category: staffCategory,
      job_description: jobDescription || null,
      notes: notes || null,
      designation_id: null,
      staff_type_id: null,
      employment_type: null,
      reporting_manager_id: null,
      department_id: departmentName ? departmentIdByName.get(departmentName) ?? null : null,
      campus_id: 1,
      reporting_time: toTime(apRow[2]),
      leaving_time: toTime(apRow[3]),
      late_relaxation_minutes: apRow[4] ? parseInt(apRow[4], 10) : null,
      monthly_pay: apRow[5] ? apRow[5] : null,
      days_per_week: apRow[9] ? parseInt(apRow[9], 10) : null,
    };

    const existing = await prisma.employee_profiles.findFirst({ where: { employee_code: employeeCode } });
    const employee = existing
      ? await prisma.employee_profiles.update({ where: { id: existing.id }, data: profileData })
      : await prisma.employee_profiles.create({ data: profileData });

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

    // --- User account (EMPLOYEE role) ---
    const username = buildUsername(fullName ?? '', employeeCode ?? '', takenUsernames);
    let userId = employee.user_id;
    let password = '';

    const existingUser = await prisma.users.findUnique({ where: { username } });
    if (existingUser) {
      userId = existingUser.id;
      if (!employee.user_id) {
        await prisma.employee_profiles.update({
          where: { id: employee.id },
          data: { user_id: userId },
        });
      }
      credentials.push({
        employee_code: employeeCode,
        full_name: fullName ?? '',
        username,
        password: '(existing — not regenerated)',
        role: StaffRole.EMPLOYEE,
      });
    } else {
      password = generatePassword();
      const hash = await bcrypt.hash(password, 10);
      userId = uuidv4();
      await prisma.users.create({
        data: {
          id: userId,
          username,
          full_name: fullName ?? username,
          password_hash: hash,
          role: StaffRole.EMPLOYEE,
          campus_id: 1,
          is_active: true,
        },
      });
      await prisma.employee_profiles.update({
        where: { id: employee.id },
        data: { user_id: userId },
      });
      credentials.push({
        employee_code: employeeCode,
        full_name: fullName ?? '',
        username,
        password,
        role: StaffRole.EMPLOYEE,
      });
    }
  }

  const credHeader = 'employee_code,full_name,username,password,role\n';
  const credRows = credentials
    .map((c) => `${c.employee_code},"${c.full_name.replace(/"/g, '""')}",${c.username},${c.password},${c.role}`)
    .join('\n');
  fs.writeFileSync(CREDENTIALS_PATH, credHeader + credRows + '\n', 'utf8');

  const reportPath = path.join(OUT_DIR, 'review-needed.txt');
  fs.writeFileSync(reportPath, reviewNotes.join('\n') + (reviewNotes.length ? '\n' : ''), 'utf8');

  console.log(`\nEmployee profiles created: ${created}, updated: ${updated}`);
  console.log(`User accounts processed: ${credentials.length}`);
  console.log(`Credentials written -> ${CREDENTIALS_PATH}`);
  console.log(`Review notes written -> ${reportPath}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
