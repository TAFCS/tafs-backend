/**
 * merge-date-of-joining.ts
 *
 * EmployeeData.csv (as submitted by HR) has no "Date of Joining" column, even
 * though that field was part of the original spec. The school does have this
 * data, buried in staff-data/TEACHER PROFILE ALL CAMPUSES - Copy.xls (one
 * sheet per campus/segment, with an "EMP. CODE #" and "DATE OF JOINING"
 * column on each).
 *
 * This script extracts Employee Code -> Date of Joining from every sheet of
 * that workbook (handling both Excel serial dates and free-text dates like
 * "AUGUST 11, 2016"), matches it onto staff-data/cleaned/EmployeeData.cleaned.csv
 * by employee code (falling back to full-name match when the code doesn't
 * line up), and inserts a new "Date of Joining" column right after
 * "Mother Name" — matching the field order originally requested.
 *
 * Requires the `xlsx` package (installed with --no-save; not a permanent
 * project dependency since this is a one-off data-recovery script).
 *
 * Usage: npx ts-node scripts/merge-date-of-joining.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { parse } from 'csv-parse/sync';

const DATA_DIR = path.join(__dirname, '..', 'staff-data');
const OUT_DIR = path.join(DATA_DIR, 'cleaned');
const XLS_PATH = path.join(DATA_DIR, 'TEACHER PROFILE ALL CAMPUSES - Copy.xls');
const CLEANED_CSV_PATH = path.join(OUT_DIR, 'EmployeeData.cleaned.csv');

const MONTHS: Record<string, number> = {
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4,
  MAY: 5, JUN: 6, JUNE: 6, JUL: 7, JULY: 7, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9,
  SEPTEMBE: 9, SEPTEMBER: 9, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11,
  DEC: 12, DECEMBER: 12,
};

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/^(MR|MRS|MS|MISS|SIR|SYED|SYEDA)\.?\s+/g, '')
    .replace(/[.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Converts an Excel serial date or a free-text "MONTH DD, YYYY" string to DD/MM/YYYY. */
function parseDoj(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;

  if (typeof raw === 'number') {
    const parsed = XLSX.SSF.parse_date_code(raw);
    if (!parsed) return null;
    return `${String(parsed.d).padStart(2, '0')}/${String(parsed.m).padStart(2, '0')}/${parsed.y}`;
  }

  const text = String(raw).trim();
  if (!text) return null;

  const match = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})$/);
  if (!match) return null;

  const monthNum = MONTHS[match[1].toUpperCase()];
  if (!monthNum) return null;

  const day = parseInt(match[2], 10);
  const year = match[3];
  return `${String(day).padStart(2, '0')}/${String(monthNum).padStart(2, '0')}/${year}`;
}

function findCol(header: any[], needle: string): number {
  return header.findIndex((h) => String(h).toUpperCase().replace(/\s+/g, ' ').includes(needle));
}

function extractDojMap(): { byCode: Map<string, { doj: string; fullName: string }>; byName: Map<string, string> } {
  const wb = XLSX.readFile(XLS_PATH);
  const byCode = new Map<string, { doj: string; fullName: string }>();
  const byName = new Map<string, string>();

  for (const sheetName of wb.SheetNames) {
    const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    const headerIdx = rows.findIndex((r) =>
      r.some((c) => String(c).toUpperCase().includes('EMP. CODE') || String(c).toUpperCase().includes('EMP CODE'))
    );
    if (headerIdx < 0) continue;

    const header = rows[headerIdx];
    const codeCol = findCol(header, 'EMP. CODE') >= 0 ? findCol(header, 'EMP. CODE') : findCol(header, 'EMP CODE');
    const nameCol = findCol(header, "EMPLOYEE'S NAME");
    const dojCol = findCol(header, 'DATE OF JOINING');
    if (codeCol < 0 || dojCol < 0) continue;

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const code = String(row[codeCol] ?? '').trim();
      if (!code) continue;

      const fullName = String(row[nameCol] ?? '').trim();
      const doj = parseDoj(row[dojCol]);
      if (!doj) continue;

      byCode.set(normalizeCode(code), { doj, fullName });
      if (fullName) byName.set(normalizeName(fullName), doj);
    }
  }

  return { byCode, byName };
}

function main() {
  const { byCode, byName } = extractDojMap();

  const raw = fs.readFileSync(CLEANED_CSV_PATH, 'utf8');
  const records: string[][] = parse(raw, { skip_empty_lines: false });
  const titleRow = records[0];
  const headerRow = records[1];
  const dataRows = records.slice(2);

  const reviewNotes: string[] = [];
  let matchedByCode = 0;
  let matchedByName = 0;
  let unmatched = 0;

  const newDataRows = dataRows.map((row) => {
    const [employeeCode, designation, fullName, fatherName, motherName, ...restOfRow] = row;
    const code = normalizeCode(employeeCode);

    let doj: string | null = null;
    const codeHit = byCode.get(code);
    if (codeHit) {
      doj = codeHit.doj;
      matchedByCode++;
    } else {
      const nameHit = byName.get(normalizeName(fullName));
      if (nameHit) {
        doj = nameHit;
        matchedByName++;
        reviewNotes.push(
          `[Date of Joining] ${employeeCode} (${fullName}): no employee-code match in the teacher-profile sheet; matched by name instead. Please confirm employee code "${employeeCode}" is correct (teacher-profile sheet may have a different code on file).`
        );
      } else {
        unmatched++;
        reviewNotes.push(`[Date of Joining] ${employeeCode} (${fullName}): not found in teacher-profile sheet — left blank, needs HR input.`);
      }
    }

    return [employeeCode, designation, fullName, fatherName, motherName, doj ?? '', ...restOfRow];
  });

  const newHeaderRow = [...headerRow];
  newHeaderRow.splice(5, 0, 'Date of Joining\n(DD/MM/YYYY)');
  const newTitleRow = [...titleRow];
  if (newTitleRow.length < newHeaderRow.length) newTitleRow.push('');

  function csvField(value: string): string {
    if (value === undefined || value === null) return '';
    const v = String(value);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }
  function writeCsv(filePath: string, rows: string[][]) {
    fs.writeFileSync(filePath, rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n', 'utf8');
  }

  writeCsv(CLEANED_CSV_PATH, [newTitleRow, newHeaderRow, ...newDataRows]);

  const reportPath = path.join(OUT_DIR, 'review-needed.txt');
  const existing = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8').trimEnd() : '';
  const existingLines = existing && existing !== 'No format issues required manual review.' ? existing.split('\n') : [];
  fs.writeFileSync(reportPath, [...existingLines, ...reviewNotes].join('\n') + '\n', 'utf8');

  console.log(`Matched by code: ${matchedByCode}`);
  console.log(`Matched by name (code mismatch): ${matchedByName}`);
  console.log(`Unmatched (left blank): ${unmatched}`);
  console.log(`EmployeeData.cleaned.csv updated with Date of Joining column.`);
  console.log(`Review notes appended -> ${reportPath}`);
}

main();
