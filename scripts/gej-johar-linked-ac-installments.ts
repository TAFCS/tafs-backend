import { PrismaClient } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const CSV_PATH = path.join(
  __dirname,
  '../student-fees-26-27/gej/linked/JOHARLINKED-2-LINKED-STUENTS-PROPER.csv',
);

const FEE_TYPE_ID = 4; // Annual Charges
const ACADEMIC_YEAR = '2026-2027';
const CREATED_BY = 'gej-johar-linked-ac-installments-script';

// Classes 15-19 are the "Secondary" system (term starts April, not August) —
// out of scope for this Aug2026-Jul2027 Cambridge-system rate table.
const EXCLUDED_CLASS_IDS = new Set([15, 16, 17, 18, 19]);

// Confirmed CC typos in the source CSV (verified by matching GR number + name
// against the live DB). Keyed by the (wrong) CC + GR the CSV lists them under.
const CC_CORRECTIONS: Record<string, number> = {
  '7077|6093': 7377, // M. BIN ABDAL
  '5059|5640': 6792, // SRISHTI KUMARI
  '7768|6361': 7788, // MUHAMMAD ALI AASIM
};

// Unresolved identity conflicts — excluded pending manual review.
const EXCLUDED_CCS = new Set<number>([4731, 7943]);

const RATE_BY_CLASS_CODE: Record<string, number> = {
  PN: 19995, NUR: 19995, KG: 19995,
  JRI: 19995, JRII: 19995, JRIII: 19995, JRIV: 19995, JRV: 19995,
  SRI: 19995, SRII: 19995, SRIII: 19995,
  OI: 20995, OII: 21995, OIII: 22995,
};

const MONTHS: { month: number; year: number }[] = [
  { month: 8, year: 2026 }, { month: 9, year: 2026 }, { month: 10, year: 2026 },
  { month: 11, year: 2026 }, { month: 12, year: 2026 }, { month: 1, year: 2027 },
  { month: 2, year: 2027 }, { month: 3, year: 2027 }, { month: 4, year: 2027 },
  { month: 5, year: 2027 }, { month: 6, year: 2027 }, { month: 7, year: 2027 },
];

function computeSchedule(total: number) {
  const q = Math.floor(total / 12);
  const r = total - q * 12;
  return MONTHS.map(({ month, year }, i) => ({ month, year, amount: i < 12 - r ? q : q + 1 }));
}

interface Candidate {
  cc: number;
  gr: string;
  csvName: string;
  csvLevel: string;
  ac: number;
  classCode: string;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 6, delayMs = 4000): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const transient = ['P1001', 'P1017', 'P2028'].includes(err?.code);
      if (!transient || i === retries - 1) throw err;
      console.log(`  (transient DB error ${err.code}, retry ${i + 1}/${retries} in ${delayMs}ms)`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function buildCandidates() {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const records: string[][] = parse(raw, { relax_column_count: true, skip_empty_lines: false });
  const dataRows = records.slice(2).filter((r) => r.length > 1 && r[1] && r[1].trim() !== '');

  const rawRows = dataRows.map((r) => ({
    csvCC: Number(r[1]),
    gr: (r[2] || '').trim(),
    level: (r[3] || '').trim(),
    name: (r[4] || '').trim(),
  }));

  const resolved = rawRows.map((r) => {
    const key = `${r.csvCC}|${r.gr}`;
    const cc = CC_CORRECTIONS[key] ?? r.csvCC;
    return { ...r, cc };
  });

  const ccList = [...new Set(resolved.map((r) => r.cc))].filter(Number.isFinite);
  const students = await withRetry(() =>
    prisma.students.findMany({
      where: { cc: { in: ccList } },
      select: { cc: true, full_name: true, class_id: true, status: true, is_complementary: true },
    }),
  );
  const byCC = Object.fromEntries(students.map((s) => [s.cc, s]));

  const classes = await withRetry(() =>
    prisma.classes.findMany({ select: { id: true, description: true, class_code: true } }),
  );
  const classById = Object.fromEntries(classes.map((c) => [c.id, c]));

  const candidates: Candidate[] = [];
  const excluded: { cc: number; gr: string; name: string; reason: string }[] = [];
  const seen = new Set<number>();

  for (const r of resolved) {
    if (EXCLUDED_CCS.has(r.cc)) { excluded.push({ ...r, reason: 'unresolved identity conflict' }); continue; }
    const s = byCC[r.cc];
    if (!s) { excluded.push({ ...r, reason: 'not found in DB' }); continue; }
    if (s.status === 'GRADUATED') { excluded.push({ ...r, reason: 'graduated' }); continue; }
    if (!s.class_id) { excluded.push({ ...r, reason: 'no class_id' }); continue; }
    if (EXCLUDED_CLASS_IDS.has(s.class_id)) { excluded.push({ ...r, reason: 'secondary system / out of scope class' }); continue; }
    if (s.is_complementary) { excluded.push({ ...r, reason: 'fee exempt (complementary)' }); continue; }
    const cls = classById[s.class_id];
    const code = (cls.class_code || '').toUpperCase().replace(/[^A-Z]/g, '');
    const rate = RATE_BY_CLASS_CODE[code];
    if (!rate) { excluded.push({ ...r, reason: `no rate mapping for class ${cls.description}` }); continue; }
    if (seen.has(r.cc)) continue; // dedupe: keep first valid occurrence per resolved CC
    seen.add(r.cc);
    candidates.push({ cc: r.cc, gr: r.gr, csvName: r.name, csvLevel: r.level, ac: rate, classCode: cls.description });
  }

  return { candidates, excluded };
}

async function alreadyMigrated(cc: number): Promise<boolean> {
  const existing = await prisma.student_fee_installments.findFirst({
    where: { student_id: cc, fee_type_id: FEE_TYPE_ID, academic_year: ACADEMIC_YEAR },
  });
  return existing !== null;
}

async function hasOtherFeeTypes(cc: number): Promise<{ skip: boolean; detail?: string }> {
  const rows = await prisma.student_fees.findMany({
    where: { student_id: cc, academic_year: ACADEMIC_YEAR, fee_type_id: { notIn: [1] } },
  });
  if (rows.length > 0) {
    return { skip: true, detail: `existing fee_type_id(s): ${[...new Set(rows.map((r) => r.fee_type_id))].join(',')}` };
  }
  return { skip: false };
}

async function processCandidate(c: Candidate) {
  return prisma.$transaction(
    async (tx) => {
      const plan = await tx.student_fee_installments.create({
        data: {
          student_id: c.cc, fee_type_id: FEE_TYPE_ID, academic_year: ACADEMIC_YEAR,
          total_amount: c.ac, installment_count: 12, created_by: CREATED_BY,
        },
      });
      const ids: number[] = [];
      for (const item of computeSchedule(c.ac)) {
        const feeDate = new Date(`${item.year}-${String(item.month).padStart(2, '0')}-01`);
        const row = await tx.student_fees.create({
          data: {
            student_id: c.cc, fee_type_id: FEE_TYPE_ID, academic_year: ACADEMIC_YEAR,
            target_month: item.month, fee_date: feeDate, amount: item.amount,
            installment_amount: item.amount, installment_id: plan.id, status: 'NOT_ISSUED',
          },
        });
        ids.push(row.id);
      }
      return { planId: plan.id, ids };
    },
    { maxWait: 5000, timeout: 30000 },
  );
}

async function main() {
  const mode = process.argv[2];
  const { candidates, excluded } = await buildCandidates();
  console.log(`Candidates eligible for AC installment: ${candidates.length}`);
  console.log(`Excluded: ${excluded.length}`);
  const byReason: Record<string, number> = {};
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
  console.log(JSON.stringify(byReason, null, 2));

  fs.writeFileSync(
    path.join(__dirname, '../student-fees-26-27/gej/linked/johar-linked-ac-excluded.csv'),
    ['CC,GR,Name,Reason', ...excluded.map((e) => `${e.cc},${e.gr},"${e.name}",${e.reason}`)].join('\n') + '\n',
  );

  if (mode !== 'test' && mode !== 'all') {
    console.log('Usage: ts-node scripts/gej-johar-linked-ac-installments.ts <test|all>');
    return;
  }

  const targets = mode === 'test' ? candidates.slice(0, 5) : candidates;
  let ok = 0, skipped = 0;
  for (const c of targets) {
    if (await withRetry(() => alreadyMigrated(c.cc))) {
      console.log(`SKIP ${c.cc} (${c.gr}) -> already has an AC installment plan`);
      skipped++;
      continue;
    }
    const other = await withRetry(() => hasOtherFeeTypes(c.cc));
    if (other.skip) {
      console.log(`SKIP ${c.cc} (${c.gr}) -> ${other.detail}`);
      skipped++;
      continue;
    }
    try {
      const result = await withRetry(() => processCandidate(c));
      console.log(`OK  ${c.cc} (${c.gr}, ${c.classCode}) -> plan ${result.planId}, total ${c.ac}`);
      ok++;
    } catch (err: any) {
      console.log(`FAIL ${c.cc} (${c.gr}) -> ${err.message}`);
      skipped++;
    }
  }
  console.log(`Done. ${ok} inserted, ${skipped} skipped, out of ${targets.length}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
