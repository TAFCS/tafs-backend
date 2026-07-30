import { PrismaClient } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const CSV_PATH = path.join(
  __dirname,
  '../student-fees-26-27/gej/single/JOHAR-SINGLE-SINGLE-CHILD-proper.csv',
);

const FEE_TYPE_ID = 4; // Annual Charges
const ACADEMIC_YEAR = '2026-2027';
const CREATED_BY = 'gej-johar-single-child-ac-installments-script';

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

function computeSchedule(total: number) {
  const q = Math.floor(total / 12);
  const r = total - q * 12;
  return MONTHS.map(({ month, year }, i) => ({
    month,
    year,
    amount: i < 12 - r ? q : q + 1,
  }));
}

interface Candidate {
  cc: number;
  grNumber: string;
  studentName: string;
  ac: number;
}

function isNumeric(v: any) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '') return false;
  return Number.isFinite(Number(s));
}

function loadCandidates(): Candidate[] {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const records: string[][] = parse(raw, { relax_column_count: true, skip_empty_lines: false });
  const dataRows = records.slice(2).filter((r) => r.length > 1 && r[1] && r[1].trim() !== '');

  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  for (const r of dataRows) {
    const cc = Number(r[1]);
    const ac = r[17]; // 2026-2027 A.C.
    if (!Number.isFinite(cc) || !isNumeric(ac) || Number(String(ac).replace(/,/g, '')) <= 0) continue;
    if (seen.has(cc)) continue; // dedupe: keep first occurrence only
    seen.add(cc);
    candidates.push({ cc, grNumber: r[2], studentName: r[3], ac: Number(String(ac).replace(/,/g, '')) });
  }
  return candidates;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 5, delayMs = 3000): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const transient = err?.code === 'P1001' || err?.code === 'P1017' || err?.code === 'P2028';
      if (!transient || i === retries - 1) throw err;
      console.log(`  (transient DB error, retrying in ${delayMs}ms... attempt ${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function processCandidate(c: Candidate) {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.student_fees.findMany({
        where: { student_id: c.cc, fee_type_id: FEE_TYPE_ID, academic_year: ACADEMIC_YEAR },
      });

      if (existing.length > 0) {
        // Only ever expected to be the two known already-PAID stale heads (7898, 5079).
        // Guard here rather than trust the earlier survey — always re-check live.
        throw new Error(`has ${existing.length} existing fee_type=4 row(s), statuses: ${existing.map((e) => e.status).join('|')} - skipping`);
      }

      const installmentGroup = await tx.student_fee_installments.create({
        data: {
          student_id: c.cc,
          fee_type_id: FEE_TYPE_ID,
          academic_year: ACADEMIC_YEAR,
          total_amount: c.ac,
          installment_count: 12,
          created_by: CREATED_BY,
        },
      });

      const schedule = computeSchedule(c.ac);
      const createdIds: number[] = [];
      for (const item of schedule) {
        const feeDate = new Date(`${item.year}-${String(item.month).padStart(2, '0')}-01`);
        const row = await tx.student_fees.create({
          data: {
            student_id: c.cc,
            fee_type_id: FEE_TYPE_ID,
            academic_year: ACADEMIC_YEAR,
            target_month: item.month,
            fee_date: feeDate,
            amount: item.amount,
            installment_amount: item.amount,
            installment_id: installmentGroup.id,
            status: 'NOT_ISSUED',
          },
        });
        createdIds.push(row.id);
      }

      return { planHeaderId: installmentGroup.id, createdIds };
    },
    { maxWait: 5000, timeout: 30000 },
  );
}

async function alreadyMigrated(cc: number): Promise<boolean> {
  const existing = await prisma.student_fee_installments.findFirst({
    where: { student_id: cc, fee_type_id: FEE_TYPE_ID, academic_year: ACADEMIC_YEAR },
  });
  return existing !== null;
}

async function main() {
  const mode = process.argv[2]; // "test" or "all"
  const candidates = loadCandidates();
  console.log(`Loaded ${candidates.length} candidates with a valid 2026-2027 A.C. value.`);

  const targets = mode === 'test' ? candidates.slice(0, 5) : candidates;
  if (mode !== 'test' && mode !== 'all') {
    console.log('Usage: ts-node scripts/gej-johar-single-child-ac-installments.ts <test|all>');
    process.exit(1);
  }

  let ok = 0, skipped = 0;
  for (const c of targets) {
    if (await withRetry(() => alreadyMigrated(c.cc))) {
      console.log(`SKIP ${c.cc} (${c.grNumber}) -> already has an installment plan for fee_type=4`);
      skipped++;
      continue;
    }
    try {
      const result = await withRetry(() => processCandidate(c));
      console.log(`OK  ${c.cc} (${c.grNumber}) -> plan header ${result.planHeaderId}, total ${c.ac}`);
      ok++;
    } catch (err: any) {
      console.log(`SKIP ${c.cc} (${c.grNumber}) -> ${err.message}`);
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
