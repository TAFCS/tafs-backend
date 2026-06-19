/**
 * clean-staff-csv.ts
 *
 * Format-only cleanup of the two HR intake sheets:
 *   staff-data/EmployeeData.csv
 *   staff-data/Attendance&Pay.csv
 *
 * This does NOT touch semantic/content fields (Designation, Job Title, Staff
 * Type, Campus, Class-Section Assignment) — those need HR clarification first.
 * It only normalizes column formatting:
 *   - trims whitespace on every cell
 *   - CNIC -> ##### -#######-# grouping when exactly 13 digits are present
 *   - Date of Birth -> DD/MM/YYYY, swapping clearly-MM/DD values (day>12)
 *   - Personal Phone -> 0XXX-XXXXXXX grouping, strips placeholder junk
 *   - Email -> lowercased/trimmed, strips placeholder junk ("NO"), fixes a
 *     stray comma-before-dot typo
 *   - Reporting/Leaving Time -> HH:MM (24h), zero-padded, seconds stripped
 *
 * Anything that can't be safely auto-fixed is left untouched and logged to
 * the console + a review-needed report file instead of being guessed at.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/clean-staff-csv.ts
 *
 * Writes:
 *   staff-data/cleaned/EmployeeData.cleaned.csv
 *   staff-data/cleaned/Attendance&Pay.cleaned.csv
 *   staff-data/cleaned/review-needed.txt
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const DATA_DIR = path.join(__dirname, '..', 'staff-data');
const OUT_DIR = path.join(DATA_DIR, 'cleaned');

const reviewNotes: string[] = [];

function csvField(value: string): string {
  if (value === undefined || value === null) return '';
  const v = String(value);
  if (/[",\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function writeCsv(filePath: string, rows: string[][]) {
  const content = rows.map((row) => row.map(csvField).join(',')).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
}

function trim(value: string): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Reformats a CNIC to #####-#######-# only if exactly 13 digits are present. */
function cleanCnic(raw: string, employeeCode: string): string {
  const value = trim(raw);
  if (!value) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 13) {
    return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
  }
  reviewNotes.push(`[CNIC] ${employeeCode}: "${value}" has ${digits.length} digits (expected 13) — left unchanged, needs HR correction.`);
  return value;
}

/** Normalizes DOB to DD/MM/YYYY, swapping unambiguous MM/DD entries. Leaves invalid dates untouched. */
function cleanDob(raw: string, employeeCode: string): string {
  const value = trim(raw);
  if (!value) return value;

  const match = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!match) {
    reviewNotes.push(`[DOB] ${employeeCode}: "${value}" is not a recognizable date — left unchanged, needs HR correction.`);
    return value;
  }

  let [, a, b, year] = match;
  let day = parseInt(a, 10);
  let month = parseInt(b, 10);

  if (day > 12 && month <= 12) {
    // First token can't be a month -> already DD/MM, keep as-is.
  } else if (month > 12 && day <= 12) {
    // Second token can't be a month -> source was MM/DD, swap to DD/MM.
    [day, month] = [month, day];
  } else if (day > 31 || month > 12 || day === 0 || month === 0) {
    reviewNotes.push(`[DOB] ${employeeCode}: "${value}" is not a valid date — left unchanged, needs HR correction.`);
    return value;
  }
  // else: both <=12, genuinely ambiguous — assume already DD/MM per template instructions, no change in value, just re-pad below.

  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

/** Normalizes phone numbers to +92XXXXXXXXXX, handles multi-number cells, strips placeholder junk. */
function cleanPhone(raw: string, employeeCode: string): string {
  const value = trim(raw);
  if (!value) return '';
  if (/^[A-Za-z#\s]+$/.test(value)) {
    // Pure placeholder text like "PERSONAL CELL #" — not a real number
    reviewNotes.push(`[Phone] ${employeeCode}: "${value}" looks like placeholder text, not a number — cleared.`);
    return '';
  }

  const numbers = value.split(/\s+/).map((part) => {
    const digits = part.replace(/\D/g, '');
    if (digits.length === 10 && digits.startsWith('3')) {
      return `+92${digits}`; // dropped leading 0
    }
    if (digits.length === 11 && digits.startsWith('0')) {
      return `+92${digits.slice(1)}`;
    }
    if (digits.length === 12 && digits.startsWith('92')) {
      return `+${digits}`;
    }
    reviewNotes.push(`[Phone] ${employeeCode}: segment "${part}" has ${digits.length} digits (expected 11) — left unchanged, needs HR correction.`);
    return part;
  });

  return numbers.join('; ');
}

/** Lowercases/trims email, strips placeholder junk, fixes an obvious stray-comma typo. */
function cleanEmail(raw: string, employeeCode: string): string {
  const value = trim(raw);
  if (!value) return '';
  if (!value.includes('@')) {
    reviewNotes.push(`[Email] ${employeeCode}: "${value}" is not an email — cleared.`);
    return '';
  }
  let cleaned = value.toLowerCase().replace(/,(?=\w*\.[a-z]+$)/, '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    reviewNotes.push(`[Email] ${employeeCode}: "${value}" still looks malformed after cleanup — needs HR correction.`);
  }
  return cleaned;
}

/** Normalizes H:MM / HH:MM[:SS] to zero-padded HH:MM. */
function cleanTime(raw: string, employeeCode: string, label: string): string {
  const value = trim(raw);
  if (!value) return value;
  const match = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) {
    reviewNotes.push(`[${label}] ${employeeCode}: "${value}" is not a recognizable time — left unchanged, needs HR correction.`);
    return value;
  }
  const [, h, m] = match;
  return `${h.padStart(2, '0')}:${m}`;
}

function cleanEmployeeData() {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'EmployeeData.csv'), 'utf8');
  const records: string[][] = parse(raw, { skip_empty_lines: false });

  const titleRow = records[0];
  const headerRow = records[1];
  const dataRows = records.slice(2);

  const cleanedRows = dataRows.map((row) => {
    const [
      employeeCode, designation, fullName, fatherName, motherName,
      cnic, dob, address, phone, email, jobTitle, jobDescription, notes,
    ] = row.map(trim);

    return [
      employeeCode,
      designation,
      fullName,
      fatherName,
      motherName,
      cleanCnic(cnic, employeeCode),
      cleanDob(dob, employeeCode),
      address,
      cleanPhone(phone, employeeCode),
      cleanEmail(email, employeeCode),
      jobTitle,
      jobDescription,
      notes,
    ];
  });

  writeCsv(path.join(OUT_DIR, 'EmployeeData.cleaned.csv'), [titleRow, headerRow, ...cleanedRows]);
  console.log(`EmployeeData.cleaned.csv written (${cleanedRows.length} rows).`);
}

function cleanAttendancePay() {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'Attendance&Pay.csv'), 'utf8');
  const records: string[][] = parse(raw, { skip_empty_lines: false });

  const titleRow = records[0];
  const headerRow = records[1];
  const dataRows = records.slice(2);

  const cleanedRows = dataRows.map((row) => {
    const [
      employeeCode, fullName, reportingTime, leavingTime, lateRelaxation,
      monthlyPay, staffType, campus, classSection, daysPerWeek,
    ] = row.map(trim);

    return [
      employeeCode,
      fullName,
      cleanTime(reportingTime, employeeCode, 'Reporting Time'),
      cleanTime(leavingTime, employeeCode, 'Leaving Time'),
      lateRelaxation,
      monthlyPay,
      staffType, // left untouched — semantic mapping, not a format issue
      campus, // left untouched — semantic mapping, not a format issue
      classSection, // left untouched — semantic mapping, not a format issue
      daysPerWeek,
    ];
  });

  writeCsv(path.join(OUT_DIR, 'Attendance&Pay.cleaned.csv'), [titleRow, headerRow, ...cleanedRows]);
  console.log(`Attendance&Pay.cleaned.csv written (${cleanedRows.length} rows).`);
}

function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  cleanEmployeeData();
  cleanAttendancePay();

  const reportPath = path.join(OUT_DIR, 'review-needed.txt');
  fs.writeFileSync(
    reportPath,
    reviewNotes.length
      ? reviewNotes.join('\n') + '\n'
      : 'No format issues required manual review.\n',
    'utf8'
  );
  console.log(`\n${reviewNotes.length} item(s) flagged for manual review -> ${reportPath}`);
}

main();
