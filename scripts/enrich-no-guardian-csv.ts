/**
 * enrich-no-guardian-csv.ts
 *
 * Enriches students_no_guardian.csv with parent data sourced from all the
 * campus father CSV files.  For every student, outputs:
 *
 *   student_cc, gr_number, full_name, class, campus_id,
 *   father_name, father_cnic, mother_name, mother_cnic
 *
 * A row is included whether parent data is found or not (blank cells when
 * data is missing).  Rows where ANY of the four parent cells is empty are
 * included — that's the whole point.
 *
 * Source files:
 *   fathers-data/missing_fathers.csv  — CC, father_name, father_cnic, mother_name, mother_cnic
 *   fathers-data/gkf-fathers.csv      — CC, father_name, father_cnic, mother_cnic
 *   fathers-data/johar-fathers.csv    — CC, father_name, father_cnic, mother_cnic
 *   fathers-data/nnn-fathers.csv      — CC, father_name, father_cnic, mother_cnic
 *   fathers-data/tafsal-fathers.csv   — CC, father_name, father_cnic, mother_cnic
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/enrich-no-guardian-csv.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

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

// ─── Parent data lookup ───────────────────────────────────────────────────────

interface ParentData {
  father_name: string;
  father_cnic: string;
  mother_name: string;
  mother_cnic: string;
}

const dataDir = path.join(__dirname, '..', 'fathers-data');

// Merge into one lookup map: CC → ParentData
const parentLookup = new Map<number, ParentData>();

function mergeFile(
  filePath: string,
  ccCol: string,
  fatherNameCol: string | null,
  fatherCnicCol: string | null,
  motherNameCol: string | null,
  motherCnicCol: string | null,
) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  ⚠  Not found, skipping: ${filePath}`);
    return;
  }
  const rows: Record<string, string>[] = parse(fs.readFileSync(filePath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  for (const row of rows) {
    const cc = parseInt(row[ccCol], 10);
    if (isNaN(cc)) continue;

    const existing = parentLookup.get(cc) ?? {
      father_name: '',
      father_cnic: '',
      mother_name: '',
      mother_cnic: '',
    };

    // Only fill in a field if we have a value and it was blank before
    if (fatherNameCol && row[fatherNameCol]?.trim()) {
      existing.father_name = existing.father_name || row[fatherNameCol].trim();
    }
    if (fatherCnicCol && row[fatherCnicCol]?.trim()) {
      existing.father_cnic = existing.father_cnic || row[fatherCnicCol].trim();
    }
    if (motherNameCol && row[motherNameCol]?.trim()) {
      existing.mother_name = existing.mother_name || row[motherNameCol].trim();
    }
    if (motherCnicCol && row[motherCnicCol]?.trim()) {
      existing.mother_cnic = existing.mother_cnic || row[motherCnicCol].trim();
    }

    parentLookup.set(cc, existing);
  }

  console.log(`  Loaded ${rows.length} rows from ${path.basename(filePath)}`);
}

// missing_fathers.csv has all four columns
mergeFile(
  path.join(dataDir, 'missing_fathers.csv'),
  'Student CC',
  'Father Name',
  'Father CNIC',
  'Mother Name',
  'Mother CNIC',
);

// Campus files have father_name, father_cnic, mother_cnic but no mother_name
for (const fname of ['gkf-fathers.csv', 'johar-fathers.csv', 'nnn-fathers.csv', 'tafsal-fathers.csv']) {
  mergeFile(
    path.join(dataDir, fname),
    'cc',
    'father_name',
    'father_cnic',
    null,        // no mother_name column
    'mother_cnic',
  );
}

console.log(`\nParent data loaded for ${parentLookup.size} unique student CCs\n`);

// ─── Load students_no_guardian.csv ────────────────────────────────────────────

const inputPath = path.join(dataDir, 'students_no_guardian.csv');
const inputRows: Record<string, string>[] = parse(fs.readFileSync(inputPath, 'utf8'), {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

console.log(`Students in no-guardian CSV: ${inputRows.length}`);

// ─── Build enriched output ────────────────────────────────────────────────────

const output = inputRows.map((row) => {
  const cc = parseInt(row['student_cc'], 10);
  const parents = parentLookup.get(cc) ?? {
    father_name: '',
    father_cnic: '',
    mother_name: '',
    mother_cnic: '',
  };

  return {
    student_cc:      row['student_cc'],
    gr_number:       row['gr_number'],
    full_name:       row['full_name'],
    class:           row['class'],
    campus_id:       row['campus_id'],
    father_name:     parents.father_name,
    father_cnic:     parents.father_cnic,
    mother_name:     parents.mother_name,
    mother_cnic:     parents.mother_cnic,
  };
});

// ─── Write output ─────────────────────────────────────────────────────────────

const outputPath = path.join(dataDir, 'students_no_guardian.csv');
fs.writeFileSync(outputPath, toCSV(output), 'utf8');

// ─── Stats ────────────────────────────────────────────────────────────────────

const withFatherName  = output.filter((r) => r.father_name).length;
const withFatherCnic  = output.filter((r) => r.father_cnic).length;
const withMotherName  = output.filter((r) => r.mother_name).length;
const withMotherCnic  = output.filter((r) => r.mother_cnic).length;
const allEmpty        = output.filter(
  (r) => !r.father_name && !r.father_cnic && !r.mother_name && !r.mother_cnic,
).length;

console.log('\n──── Output stats ────');
console.log(`Total rows:              ${output.length}`);
console.log(`Have father name:        ${withFatherName}`);
console.log(`Have father CNIC:        ${withFatherCnic}`);
console.log(`Have mother name:        ${withMotherName}`);
console.log(`Have mother CNIC:        ${withMotherCnic}`);
console.log(`No parent data at all:   ${allEmpty}`);
console.log(`\nWrote: ${outputPath}`);
