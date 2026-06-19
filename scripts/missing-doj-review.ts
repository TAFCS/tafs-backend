/**
 * missing-doj-review.ts
 *
 * Builds a focused sheet for HR: every employee in EmployeeData.cleaned.csv
 * whose Date of Joining is still blank (not recoverable from the
 * teacher-profile workbook), together with any other review-needed flags
 * already raised for that same employee code (CNIC/phone/DOB/email issues
 * from the format-cleanup pass, code mismatches, etc.) so HR has one sheet
 * to work through instead of cross-referencing two files.
 *
 * Usage: npx ts-node scripts/missing-doj-review.ts
 * Writes: staff-data/cleaned/missing-date-of-joining.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const OUT_DIR = path.join(__dirname, '..', 'staff-data', 'cleaned');
const CLEANED_CSV_PATH = path.join(OUT_DIR, 'EmployeeData.cleaned.csv');
const REVIEW_PATH = path.join(OUT_DIR, 'review-needed.txt');
const OUTPUT_PATH = path.join(OUT_DIR, 'missing-date-of-joining.csv');

function csvField(value: string): string {
  if (value === undefined || value === null) return '';
  const v = String(value);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function writeCsv(filePath: string, rows: string[][]) {
  fs.writeFileSync(filePath, rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n', 'utf8');
}

function main() {
  const raw = fs.readFileSync(CLEANED_CSV_PATH, 'utf8');
  const records: string[][] = parse(raw, { skip_empty_lines: false });
  const dataRows = records.slice(2);

  const reviewLines = fs
    .readFileSync(REVIEW_PATH, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const notesByCode = new Map<string, string[]>();
  for (const line of reviewLines) {
    const match = line.match(/^\[([^\]]+)\]\s+([^\s:(]+)\s*(?:\([^)]*\))?:\s*(.+)$/);
    if (!match) continue;
    const [, category, code, message] = match;
    const key = code.trim().toUpperCase();
    if (!notesByCode.has(key)) notesByCode.set(key, []);
    notesByCode.get(key)!.push(`[${category}] ${message}`);
  }

  const missingRows = dataRows
    .filter((row) => !row[5] || !row[5].trim())
    .map((row) => {
      const employeeCode = row[0];
      const designation = row[1];
      const fullName = row[2];
      const notes = notesByCode.get(employeeCode.trim().toUpperCase()) ?? [];
      return [employeeCode, fullName, designation, notes.join(' | ')];
    });

  writeCsv(OUTPUT_PATH, [
    ['Employee Code', 'Full Name', 'Designation', 'Other Review Notes'],
    ...missingRows,
  ]);

  console.log(`${missingRows.length} employees missing Date of Joining -> ${OUTPUT_PATH}`);
}

main();
