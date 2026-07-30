import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import * as path from 'path';

const prisma = new PrismaClient();

const DRY_RUN_XLSX = path.join(
  __dirname,
  '../student-fees-26-27/gkf/campus2_annual_charges_12_installments_dry_run.xlsx',
);

const FEE_TYPE_ID = 4; // Annual Charges
const ACADEMIC_YEAR = '2026-2027';
const CREATED_BY = 'gkf-installments-migration-script';

// Known leftover test rows on the sandbox student (CC 7596) from earlier manual
// experiments — never linked to a real installment plan (installment_id null),
// all mis-dated to Aug 2026. Deleted alongside the real head before re-inserting.
const JUNK_IDS_TO_DELETE = [
  13238, 13251, 13264, 13265, 13278, 13291, 13292, 13305, 13318, 13319, 13332, 13345,
];

interface SummaryRow {
  'S.No': number;
  'Fee Record ID': number;
  'Student CC': number;
  'G.R. Number': string;
  'Student Name': string;
  'Academic Year': string;
  'Total Annual Charge (Rs.)': number;
  Status: string;
}

interface DetailRow {
  'Student CC': number;
  'Fee Date': string;
  'Target Month': number;
  'Monthly Installment Amount (Rs.)': number;
}

function loadPlan() {
  const wb = XLSX.readFile(DRY_RUN_XLSX);
  const summary = XLSX.utils.sheet_to_json<SummaryRow>(wb.Sheets['Student Summary Breakdown'], { defval: null });
  const detail = XLSX.utils.sheet_to_json<DetailRow>(wb.Sheets['Monthly Installments Detail'], { defval: null });

  const students = summary.filter((r) => r.Status !== 'PAID');

  return students.map((s) => {
    const schedule = detail
      .filter((d) => d['Student CC'] === s['Student CC'])
      .map((d) => ({
        target_month: d['Target Month'],
        fee_date: d['Fee Date'],
        amount: d['Monthly Installment Amount (Rs.)'],
      }));

    if (schedule.length !== 12) {
      throw new Error(`Student ${s['Student CC']}: expected 12 schedule rows, found ${schedule.length}`);
    }
    const sum = schedule.reduce((a, x) => a + x.amount, 0);
    if (sum !== s['Total Annual Charge (Rs.)']) {
      throw new Error(
        `Student ${s['Student CC']}: schedule sum ${sum} != total annual charge ${s['Total Annual Charge (Rs.)']}`,
      );
    }

    return {
      studentCC: s['Student CC'],
      grNumber: s['G.R. Number'],
      studentName: s['Student Name'],
      totalAmount: s['Total Annual Charge (Rs.)'],
      schedule,
    };
  });
}

async function alreadyMigrated(studentCC: number): Promise<boolean> {
  const existing = await prisma.student_fee_installments.findFirst({
    where: { student_id: studentCC, fee_type_id: FEE_TYPE_ID, academic_year: ACADEMIC_YEAR },
  });
  return existing !== null;
}

async function processStudent(plan: ReturnType<typeof loadPlan>[number]) {
  return prisma.$transaction(
    async (tx) => {
      // Clean up known junk test rows (only ever present for CC 7596, from an
      // earlier manual test run). Tolerate them already being gone (re-run safety).
      if (plan.studentCC === 7596 && JUNK_IDS_TO_DELETE.length > 0) {
        await tx.student_fees.deleteMany({
          where: { id: { in: JUNK_IDS_TO_DELETE }, student_id: 7596, installment_id: null },
        });
      }

      // Re-match the original annual-charges head by (student, fee_type, year, amount) —
      // NOT by the "Fee Record ID" baked into the dry-run report, which is stale
      // (the ids it references no longer exist in this DB).
      const candidates = await tx.student_fees.findMany({
        where: {
          student_id: plan.studentCC,
          fee_type_id: FEE_TYPE_ID,
          academic_year: ACADEMIC_YEAR,
          installment_id: null,
        },
      });
      const matches = candidates.filter((c) => Number(c.amount) === plan.totalAmount);
      if (matches.length !== 1) {
        throw new Error(
          `Student ${plan.studentCC}: expected exactly 1 matching original head, found ${matches.length}`,
        );
      }
      const originalHead = matches[0];
      if (originalHead.status !== 'NOT_ISSUED') {
        throw new Error(`Student ${plan.studentCC}: original head ${originalHead.id} is not NOT_ISSUED`);
      }

      await tx.student_fees.delete({ where: { id: originalHead.id } });

      const installmentGroup = await tx.student_fee_installments.create({
        data: {
          student_id: plan.studentCC,
          fee_type_id: FEE_TYPE_ID,
          academic_year: ACADEMIC_YEAR,
          total_amount: plan.totalAmount,
          installment_count: plan.schedule.length,
          created_by: CREATED_BY,
        },
      });

      const createdIds: number[] = [];
      for (const item of plan.schedule) {
        const row = await tx.student_fees.create({
          data: {
            student_id: plan.studentCC,
            fee_type_id: FEE_TYPE_ID,
            academic_year: ACADEMIC_YEAR,
            target_month: item.target_month,
            fee_date: new Date(item.fee_date),
            amount: item.amount,
            installment_amount: item.amount,
            installment_id: installmentGroup.id,
            status: 'NOT_ISSUED',
          },
        });
        createdIds.push(row.id);
      }

      return { deletedHeadId: originalHead.id, planHeaderId: installmentGroup.id, createdIds };
    },
    { maxWait: 5000, timeout: 30000 },
  );
}

async function main() {
  const mode = process.argv[2]; // "test" or "all"
  const plans = loadPlan();
  console.log(`Loaded plan for ${plans.length} students (excludes PAID-flagged students).`);

  if (mode === 'test') {
    const testPlan = plans.find((p) => p.studentCC === 7596);
    if (!testPlan) throw new Error('Test student 7596 not found in plan');
    console.log('Running SINGLE test insertion for CC 7596...');
    const result = await processStudent(testPlan);
    console.log('Result:', JSON.stringify(result, null, 2));
  } else if (mode === 'all') {
    console.log(`Running for ALL ${plans.length} students...`);
    const results: any[] = [];
    for (const plan of plans) {
      if (await alreadyMigrated(plan.studentCC)) {
        console.log(`SKIP ${plan.studentCC} (${plan.grNumber}) -> already has an installment plan for this fee type/year`);
        continue;
      }
      try {
        const result = await processStudent(plan);
        results.push({ cc: plan.studentCC, gr: plan.grNumber, ...result });
        console.log(`OK  ${plan.studentCC} (${plan.grNumber}) -> plan header ${result.planHeaderId}`);
      } catch (err: any) {
        console.error(`FAIL ${plan.studentCC} (${plan.grNumber}): ${err.message}`);
        throw err; // stop on first failure — investigate before continuing
      }
    }
    console.log(`Done. ${results.length}/${plans.length} students processed.`);
  } else {
    console.log('Usage: ts-node scripts/gkf-campus2-annual-charges-to-installments.ts <test|all>');
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
