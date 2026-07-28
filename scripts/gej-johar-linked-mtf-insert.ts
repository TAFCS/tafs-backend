import { PrismaClient } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const CSV_PATH = path.join(
  __dirname,
  '../student-fees-26-27/gej/linked/JOHARLINKED-2-LINKED-STUENTS-PROPER.csv',
);
const SKIPPED_REPORT_PATH = path.join(
  __dirname,
  '../student-fees-26-27/gej/linked/JOHAR-LINKED-MTF-skipped-report.csv',
);
const INSERTED_REPORT_PATH = path.join(
  __dirname,
  '../student-fees-26-27/gej/linked/JOHAR-LINKED-MTF-inserted-report.csv',
);

const FEE_TYPE_ID = 1; // Monthly Tuition Fee
const ACADEMIC_YEAR = '2026-2027';
const EXCLUDED_CLASS_IDS = new Set([15, 16, 17, 18, 19]);

// Confirmed manually: two rows for this student had conflicting amounts (22995 vs 21995).
// 21995 confirmed correct.
const AMOUNT_OVERRIDE_BY_CC = new Map<number, number>([[6612, 21995]]);

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
  grNumber: string;
  studentName: string;
  cleanedMtf: number;
  rowIndex: number;
}

function loadRows(): Row[] {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const records: string[][] = parse(raw, { relax_column_count: true, skip_empty_lines: false });
  const dataRows = records.slice(2);

  const rows: Row[] = [];
  dataRows.forEach((r, idx) => {
    if (!r[1] || r[1].trim() === '') return;
    const grNumber = (r[2] || '').trim();
    const studentName = (r[4] || '').trim();
    const cleanedRaw = (r[24] || '').trim();
    if (cleanedRaw === '') return;
    const cleaned = Number(cleanedRaw);
    if (!Number.isFinite(cleaned)) return; // skip non-numeric (F.E, COMP, QUIT, etc)
    rows.push({ grNumber, studentName, cleanedMtf: cleaned, rowIndex: idx + 3 });
  });
  return rows;
}

async function main() {
  const mode = process.argv[2]; // "test" or "all"
  if (mode !== 'test' && mode !== 'all') {
    console.log('Usage: ts-node scripts/gej-johar-linked-mtf-insert.ts <test|all>');
    process.exit(1);
  }

  const rows = loadRows();
  console.log(`Loaded ${rows.length} rows with numeric Cleaned MTF from CSV.`);

  const grNumbers = [...new Set(rows.map((r) => r.grNumber))];
  const students = await prisma.students.findMany({
    where: { gr_number: { in: grNumbers } },
    select: { cc: true, gr_number: true, full_name: true, class_id: true },
  });
  const byGr = new Map(students.map((s) => [s.gr_number, s]));

  const skipped: { cc: number | ''; gr: string; name: string; expected: number; reason: string }[] = [];
  const byCc = new Map<number, { studentName: string; grNumber: string; cleanedMtf: number }>();

  for (const row of rows) {
    const s = byGr.get(row.grNumber);
    if (!s) {
      skipped.push({ cc: '', gr: row.grNumber, name: row.studentName, expected: row.cleanedMtf, reason: 'GR_NOT_FOUND_IN_DB' });
      continue;
    }
    if (s.class_id !== null && EXCLUDED_CLASS_IDS.has(s.class_id)) {
      skipped.push({ cc: s.cc, gr: row.grNumber, name: row.studentName, expected: row.cleanedMtf, reason: `EXCLUDED_CLASS_ID_${s.class_id}` });
      continue;
    }

    const amount = AMOUNT_OVERRIDE_BY_CC.get(s.cc) ?? row.cleanedMtf;

    const existingForCc = byCc.get(s.cc);
    if (existingForCc) {
      if (existingForCc.cleanedMtf !== amount) {
        console.log(`WARNING: cc=${s.cc} has conflicting amounts (${existingForCc.cleanedMtf} vs ${amount}) and no override — keeping first seen.`);
      }
      continue; // dedupe: keep first occurrence per resolved cc
    }
    byCc.set(s.cc, { studentName: s.full_name, grNumber: row.grNumber, cleanedMtf: amount });
  }

  console.log(`Resolved to ${byCc.size} unique students after DB lookup, class exclusion, and dedupe.`);

  const toInsert: { cc: number; grNumber: string; studentName: string; cleanedMtf: number }[] = [];
  const candidateCcs = [...byCc.keys()];
  const existingFees = await prisma.student_fees.findMany({
    where: { student_id: { in: candidateCcs }, fee_type_id: FEE_TYPE_ID, academic_year: ACADEMIC_YEAR },
    select: { student_id: true, status: true, amount: true },
  });
  const existingByCc = new Map<number, { status: string; amount: any }[]>();
  for (const ef of existingFees) {
    if (!existingByCc.has(ef.student_id)) existingByCc.set(ef.student_id, []);
    existingByCc.get(ef.student_id)!.push({ status: ef.status || 'NOT_ISSUED', amount: ef.amount });
  }

  for (const [cc, info] of byCc) {
    const existing = existingByCc.get(cc);
    if (!existing || existing.length === 0) {
      toInsert.push({ cc, grNumber: info.grNumber, studentName: info.studentName, cleanedMtf: info.cleanedMtf });
    } else if (existing.some((e) => e.status !== 'NOT_ISSUED')) {
      skipped.push({
        cc,
        gr: info.grNumber,
        name: info.studentName,
        expected: info.cleanedMtf,
        reason: `HAS_ISSUED_OR_PAID (statuses: ${[...new Set(existing.map((e) => e.status))].join('|')}, amounts: ${[...new Set(existing.map((e) => String(e.amount)))].join('|')})`,
      });
    } else {
      skipped.push({
        cc,
        gr: info.grNumber,
        name: info.studentName,
        expected: info.cleanedMtf,
        reason: `ALREADY_HAS_${existing.length}_NOT_ISSUED_ROWS (amounts: ${[...new Set(existing.map((e) => String(e.amount)))].join('|')})`,
      });
    }
  }

  console.log(`To insert: ${toInsert.length} students (${toInsert.length * 12} rows)`);
  console.log(`Skipped total: ${skipped.length}`);

  fs.writeFileSync(
    SKIPPED_REPORT_PATH,
    ['Student CC,GR Number,Student Name,Expected Cleaned MTF,Reason', ...skipped.map((s) => `${s.cc},${s.gr},"${s.name}",${s.expected},"${s.reason}"`)].join('\n') + '\n',
  );
  console.log(`Wrote skipped report: ${SKIPPED_REPORT_PATH}`);

  const targets = mode === 'test' ? toInsert.slice(0, 1) : toInsert;

  const results: { cc: number; gr: string; name: string; amount: number; createdIds: number[] }[] = [];
  for (const row of targets) {
    const data = MONTHS.map(({ month, year }) => ({
      student_id: row.cc,
      fee_type_id: FEE_TYPE_ID,
      academic_year: ACADEMIC_YEAR,
      month,
      target_month: month,
      fee_date: new Date(`${year}-${String(month).padStart(2, '0')}-01`),
      amount: row.cleanedMtf,
      status: 'NOT_ISSUED' as const,
      precedence_override: 0,
    }));
    await prisma.student_fees.createMany({ data });
    const created = await prisma.student_fees.findMany({
      where: { student_id: row.cc, fee_type_id: FEE_TYPE_ID, academic_year: ACADEMIC_YEAR },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const createdIds = created.map((c) => c.id);
    results.push({ cc: row.cc, gr: row.grNumber, name: row.studentName, amount: row.cleanedMtf, createdIds });
    console.log(`OK  ${row.cc} (${row.grNumber}) -> 12 rows @ ${row.cleanedMtf}, ids ${createdIds[0]}-${createdIds[createdIds.length - 1]}`);
  }

  if (mode === 'all') {
    fs.writeFileSync(
      INSERTED_REPORT_PATH,
      ['Student CC,GR Number,Student Name,Amount Inserted (Rs.),Fee IDs (12 rows, Aug2026-Jul2027)', ...results.map((r) => `${r.cc},${r.gr},"${r.name}",${r.amount},${r.createdIds.join('|')}`)].join('\n') + '\n',
    );
    console.log(`Wrote inserted report: ${INSERTED_REPORT_PATH}`);
  }

  console.log(`Done. ${results.length}/${targets.length} students processed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
