/**
 * build-salary-breakdown-sheet.ts
 *
 * Generates a sheet for HR/admin to break the current "Total Monthly Pay"
 * figure (from Attendance&Pay.cleaned.csv) into Base Salary + named
 * allowance columns. Total Monthly Pay is carried over read-only for
 * reference; admin fills in Base Salary, Transport Allowance, and can add
 * further allowance columns (Medical, House Rent, Utilities, etc.) the same
 * way. Base Salary + all allowance columns for a row should sum to the
 * Total Monthly Pay shown for that employee.
 *
 * Usage: npx ts-node scripts/build-salary-breakdown-sheet.ts
 * Writes: staff-data/cleaned/SalaryBreakdown.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const OUT_DIR = path.join(__dirname, '..', 'staff-data', 'cleaned');
const ATTENDANCE_PAY_PATH = path.join(OUT_DIR, 'Attendance&Pay.cleaned.csv');
const OUTPUT_PATH = path.join(OUT_DIR, 'SalaryBreakdown.csv');

function csvField(value: string): string {
  if (value === undefined || value === null) return '';
  const v = String(value);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function writeCsv(filePath: string, rows: string[][]) {
  fs.writeFileSync(filePath, rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n', 'utf8');
}

function main() {
  const raw = fs.readFileSync(ATTENDANCE_PAY_PATH, 'utf8');
  const records: string[][] = parse(raw, { skip_empty_lines: false });
  const dataRows = records.slice(2);

  const titleRow = [
    'TAFS — Salary Breakdown   |   One row per employee. Total Monthly Pay is shown for reference only — do not edit it here (correct it in Attendance & Pay Settings instead). Fill in Base Salary and each allowance column. Base Salary + all allowance columns must add up to Total Monthly Pay for that row. Add more allowance columns as needed (e.g. Medical Allowance, House Rent Allowance, Utilities Allowance) — keep one column per allowance type.',
    '', '', '', '',
  ];
  const headerRow = [
    'Employee Code\n(must match Sheet 1)',
    'Full Name\n(for reference)',
    'Total Monthly Pay\n(PKR, read-only reference)',
    'Base Salary\n(PKR)',
    'Transport Allowance\n(PKR)',
  ];

  const outRows = dataRows
    .filter((row) => row[0] && row[0].trim())
    .map((row) => {
      const employeeCode = row[0];
      const fullName = row[1];
      const totalMonthlyPay = row[5] ?? '';
      return [employeeCode, fullName, totalMonthlyPay, '', ''];
    });

  writeCsv(OUTPUT_PATH, [titleRow, headerRow, ...outRows]);

  const missingTotal = outRows.filter((r) => !r[2]).length;
  console.log(`${outRows.length} employees written -> ${OUTPUT_PATH}`);
  console.log(`${missingTotal} of those have no Total Monthly Pay yet (still pending from Attendance & Pay sheet).`);
}

main();
