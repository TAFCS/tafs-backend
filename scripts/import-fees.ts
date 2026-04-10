import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();

// ── Month name / abbreviation → month number ───────────────────────────────
const MONTH_MAP: Record<string, number> = {
  JANUARY: 1,
  JAN: 1,
  FEBRUARY: 2,
  FEB: 2,
  MARCH: 3,
  MAR: 3,
  APRIL: 4,
  APR: 4,
  MAY: 5,
  JUNE: 6,
  JUN: 6,
  JULY: 7,
  JUL: 7,
  AUGUST: 8,
  AUG: 8,
  SEPTEMBER: 9,
  SEP: 9,
  OCTOBER: 10,
  OCT: 10,
  NOVEMBER: 11,
  NOV: 11,
  DECEMBER: 12,
  DEC: 12,
};

// The 4 months "CURRENT FEES" and "APR-MAY-JUN-JUL" expand into
const CURRENT_FEES_MONTHS = [4, 5, 6, 7]; // APR, MAY, JUN, JUL

const ACADEMIC_YEAR = '2025-26';

/**
 * Normalise a fee_period string from the CSV into a list of month numbers.
 * Returns [] for rows that should be skipped (anomalies, unparseable periods).
 */
function parseFeePeriod(raw: string): number[] {
  const period = raw.trim().toUpperCase();

  if (period === 'CURRENT FEES') return CURRENT_FEES_MONTHS;
  if (period === 'APR-MAY-JUN-JUL') return CURRENT_FEES_MONTHS;

  // Strip year suffixes like "'2026", "' 2026", " 2026" at the end
  const clean = period
    .replace(/'?\s*20\d\d\s*$/, '')
    .replace(/\s+/g, '')
    .trim();

  if (MONTH_MAP[clean] !== undefined) {
    return [MONTH_MAP[clean]];
  }

  return [];
}

/** Build a fee_date Date from month number (day = 1, year = 2026) */
function feeDate(month: number): Date {
  return new Date(Date.UTC(2026, month - 1, 1));
}

async function main() {
  const dryRun = process.env.DRY_RUN !== 'false';
  console.log(dryRun ? '--- DRY RUN MODE (set DRY_RUN=false to apply) ---' : '--- EXECUTION MODE ---');

  // ── 1. Load the CSV ──────────────────────────────────────────────────────
  const csvPath = path.join(__dirname, 'fees.csv');
  const raw = fs.readFileSync(csvPath, 'utf8');
  const records: { cc: string; student_name: string; fee_period: string; amount: string; anomaly_note: string; source_file: string }[] =
    parse(raw, { columns: true, skip_empty_lines: true, trim: true });

  console.log(`Total CSV rows: ${records.length}`);

  // ── 2. Find the default fee_type ─────────────────────────────────────────
  const feeTypes = await prisma.fee_types.findMany({ orderBy: { id: 'asc' } });
  if (feeTypes.length === 0) {
    console.error('No fee_types found. Please seed fee types first.');
    process.exit(1);
  }
  const defaultFeeType =
    feeTypes.find((ft) => ft.freq === 'MONTHLY') ?? feeTypes[0];
  console.log(`Using fee_type: id=${defaultFeeType.id} | "${defaultFeeType.description}" | freq=${defaultFeeType.freq ?? 'null'}`);

  // ── 3. Pre-fetch all valid CCs ───────────────────────────────────────────
  const allStudents = await prisma.students.findMany({
    select: { cc: true },
    where: { deleted_at: null },
  });
  const existingCCs = new Set(allStudents.map((s) => s.cc));
  console.log(`Found ${existingCCs.size} active students in DB.`);

  // ── 4. Build all rows to insert ───────────────────────────────────────────
  type FeeRow = {
    student_id: number;
    fee_type_id: number;
    month: number;
    target_month: number;
    academic_year: string;
    amount: number;
    fee_date: Date;
    status: 'NOT_ISSUED';
    precedence_override: number;
  };

  const rowsToInsert: FeeRow[] = [];
  let skipAnomalyCount = 0;
  let skipMissingStudentCount = 0;
  let skipUnknownPeriodCount = 0;
  let skipNonNumericAmountCount = 0;

  for (const row of records) {
    if (!row.cc || row.cc.trim() === '') { skipMissingStudentCount++; continue; }

    const cc = parseInt(row.cc.trim(), 10);
    if (isNaN(cc)) { skipMissingStudentCount++; continue; }

    if (row.anomaly_note && row.anomaly_note.trim() !== '') { skipAnomalyCount++; continue; }

    const amount = parseFloat(row.amount.trim());
    if (isNaN(amount)) { skipNonNumericAmountCount++; continue; }

    if (!existingCCs.has(cc)) { skipMissingStudentCount++; continue; }

    const months = parseFeePeriod(row.fee_period);
    if (months.length === 0) { skipUnknownPeriodCount++; continue; }

    for (const month of months) {
      rowsToInsert.push({
        student_id: cc,
        fee_type_id: defaultFeeType.id,
        month,
        target_month: month,
        academic_year: ACADEMIC_YEAR,
        amount,
        fee_date: feeDate(month),
        status: 'NOT_ISSUED',
        precedence_override: 0,
      });
    }
  }

  console.log(`\nRows to insert: ${rowsToInsert.length}`);
  console.log(`Skipped (anomaly):       ${skipAnomalyCount}`);
  console.log(`Skipped (no/bad CC):     ${skipMissingStudentCount}`);
  console.log(`Skipped (non-numeric):   ${skipNonNumericAmountCount}`);
  console.log(`Skipped (unknown period):${skipUnknownPeriodCount}`);

  if (dryRun) {
    // Print first few rows as preview
    console.log('\nSample rows (first 10):');
    rowsToInsert.slice(0, 10).forEach((r) =>
      console.log(
        `  CC=${r.student_id} | month=${r.month} | target_month=${r.target_month} | amount=${r.amount} | fee_date=${r.fee_date.toISOString().slice(0, 10)}`,
      ),
    );
    console.log('\nRe-run with DRY_RUN=false to apply changes.');
    return;
  }

  // ── 5. Batch insert (skipDuplicates = ignore conflict) ───────────────────
  const BATCH_SIZE = 100;
  let inserted = 0;

  for (let i = 0; i < rowsToInsert.length; i += BATCH_SIZE) {
    const batch = rowsToInsert.slice(i, i + BATCH_SIZE);
    const result = await prisma.student_fees.createMany({
      data: batch,
      skipDuplicates: true,
    });
    inserted += result.count;
    process.stdout.write(`\rProgress: ${Math.min(i + BATCH_SIZE, rowsToInsert.length)}/${rowsToInsert.length} rows processed...`);
  }

  console.log(`\n\n══════════════════════════════════════════`);
  console.log(`DONE`);
  console.log(`══════════════════════════════════════════`);
  console.log(`Total rows attempted:  ${rowsToInsert.length}`);
  console.log(`Actually inserted:     ${inserted}`);
  console.log(`Duplicates skipped:    ${rowsToInsert.length - inserted}`);
}

main()
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
