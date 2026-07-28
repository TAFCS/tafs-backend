import { PrismaClient } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const CSV_PATH = path.join(
  __dirname,
  '../student-fees-26-27/gej/single/JOHAR-SINGLE-SINGLE-CHILD-proper.csv',
);

const FEE_TYPE_ID = 1; // Monthly Tuition Fee
const ACADEMIC_YEAR = '2026-2027';

// Aug 2026 -> Jul 2027, in calendar order
const MONTHS: { month: number; year: number }[] = [
  { month: 8, year: 2026 },
  { month: 9, year: 2026 },
  { month: 10, year: 2026 },
  { month: 11, year: 2026 },
  { month: 12, year: 2026 },
  { month: 1, year: 2027 },
  { month: 2, year: 2027 },
  { month: 3, year: 2027 },
  { month: 4, year: 2027 },
  { month: 5, year: 2027 },
  { month: 6, year: 2027 },
  { month: 7, year: 2027 },
];

interface Row {
  cc: number;
  grNumber: string;
  studentName: string;
  cleanedMtf: number;
}

// CC 7323 (SYED MUHAMMAD SAIM HUSSAIN ZAIDI) appeared twice in the source sheet
// with two conflicting MTF values (17995 vs 18995) — confirmed correct value is
// 17995 (the first occurrence), which loadRows() keeps automatically via dedupe.
const EXCLUDED_CCS = new Set<number>([]);

function loadRows(): Row[] {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const records: string[][] = parse(raw, { relax_column_count: true, skip_empty_lines: false });
  const dataRows = records.slice(2).filter((r) => r.length > 1 && r[1] && r[1].trim() !== '');

  const seenCCs = new Set<number>();
  const rows: Row[] = [];
  for (const r of dataRows) {
    const cc = Number(r[1]);
    const cleanedRaw = r[21]; // last column: "Cleaned MTF (2026-2027)"
    if (!Number.isFinite(cc) || cleanedRaw === undefined || cleanedRaw === '') continue;
    if (EXCLUDED_CCS.has(cc)) continue;
    if (seenCCs.has(cc)) continue; // dedupe: keep first occurrence only
    const cleaned = Number(cleanedRaw);
    if (!Number.isFinite(cleaned)) continue;
    seenCCs.add(cc);
    rows.push({ cc, grNumber: r[2], studentName: r[3], cleanedMtf: cleaned });
  }
  return rows;
}

async function main() {
  const mode = process.argv[2]; // "test" or "all"
  const rows = loadRows();
  console.log(`Loaded ${rows.length} students with a numeric Cleaned MTF value.`);

  const toInsert: Row[] = [];
  const skippedAllNotIssued: { cc: number; grNumber: string; studentName: string }[] = [];
  const skippedHasIssuedOrPaid: { cc: number; grNumber: string; studentName: string }[] = [];

  for (const row of rows) {
    const existing = await prisma.student_fees.findMany({
      where: { student_id: row.cc, fee_type_id: FEE_TYPE_ID, academic_year: ACADEMIC_YEAR },
    });
    if (existing.length === 0) {
      toInsert.push(row);
    } else if (existing.some((e) => e.status !== 'NOT_ISSUED')) {
      skippedHasIssuedOrPaid.push(row);
    } else {
      skippedAllNotIssued.push(row);
    }
  }

  console.log(`To insert (zero existing rows): ${toInsert.length}`);
  console.log(`Skipped (already has ISSUED/PAID/PARTIALLY_PAID): ${skippedHasIssuedOrPaid.length}`);
  console.log(`Skipped (12 existing rows, all NOT_ISSUED): ${skippedAllNotIssued.length}`);

  fs.writeFileSync(
    path.join(__dirname, '../student-fees-26-27/gej/single/JOHAR-SINGLE-CHILD-skipped-all-not-issued.csv'),
    ['Student CC,GR Number,Student Name', ...skippedAllNotIssued.map((r) => `${r.cc},${r.grNumber},${r.studentName}`)].join('\n') + '\n',
  );

  const targets = mode === 'test' ? toInsert.slice(0, 1) : toInsert;

  if (mode !== 'test' && mode !== 'all') {
    console.log('Usage: ts-node scripts/gej-johar-single-child-mtf-insert.ts <test|all>');
    process.exit(1);
  }

  const results: any[] = [];
  for (const row of targets) {
    const createdIds = await prisma.$transaction(async (tx) => {
      const ids: number[] = [];
      for (const { month, year } of MONTHS) {
        const feeDate = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
        const created = await tx.student_fees.create({
          data: {
            student_id: row.cc,
            fee_type_id: FEE_TYPE_ID,
            academic_year: ACADEMIC_YEAR,
            month,
            target_month: month,
            fee_date: feeDate,
            amount: row.cleanedMtf,
            status: 'NOT_ISSUED',
            precedence_override: 0,
          },
        });
        ids.push(created.id);
      }
      return ids;
    });
    results.push({ cc: row.cc, gr: row.grNumber, name: row.studentName, amount: row.cleanedMtf, createdIds });
    console.log(`OK  ${row.cc} (${row.grNumber}) -> 12 rows @ ${row.cleanedMtf}, ids ${createdIds[0]}-${createdIds[createdIds.length - 1]}`);
  }

  console.log(`Done. ${results.length}/${targets.length} students processed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
