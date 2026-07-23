/**
 * Manual verification for the Payroll Settlement & Test Mode plan.
 * Exercises the real PayrollService (via a Nest application context) against
 * the two QA fixture employees — never touches real campus payroll data
 * beyond a throwaway DRAFT real run used purely to prove non-collision.
 *
 * Usage: npx ts-node scripts/verify-payroll-settlement.ts
 */
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HrModule } from '../src/modules/hr/hr.module';
import { AuditLogsModule } from '../src/modules/audit-logs/audit-logs.module';
import { PayrollService } from '../src/modules/hr/payroll/payroll.service';
import { PrismaService } from '../prisma/prisma.service';
import type { IJwtStaffPayload } from '../src/modules/auth/interfaces/jwt-payload.interface';
import { computePayrollWindow } from '../src/modules/hr/payroll/payroll-period.util';

@Module({ imports: [PrismaModule, AuditLogsModule, HrModule] })
class VerifyModule {}

const CAMPUS_ID = 1;
const MIRZA_ID = 175; // EMP-MHM-001
const HASHIR_ID = 184; // TEST-HASHIR-001
const YEAR = Number(process.env.VERIFY_YEAR) || 2026;
const MONTH = Number(process.env.VERIFY_MONTH) || 3; // Feb 26 -> Mar 25 2026 — a past, low-traffic period by default

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  OK   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`, detail ?? '');
  }
}

async function main() {
  const app = await NestFactory.createApplicationContext(VerifyModule, { logger: ['error', 'warn'] });
  const payroll = app.get(PayrollService);
  const prisma = app.get(PrismaService);

  const adminUserRow = await prisma.users.findFirst({ where: { is_active: true }, select: { id: true, username: true } });
  if (!adminUserRow) throw new Error('No active user found to act as the settling admin.');
  const user: IJwtStaffPayload = {
    sub: adminUserRow.id,
    username: adminUserRow.username,
    role: 'SUPER_ADMIN' as any,
    campusId: null,
    allowedClassIds: [],
    userType: 'STAFF',
    permissions: ['*'],
  };

  console.log(`\nUsing admin user ${adminUserRow.username} (${adminUserRow.id})\n`);

  // ── 0. Snapshot: does a real run already exist for this campus/period? ──
  const { periodStart, periodEnd } = computePayrollWindow(YEAR, MONTH);
  const existingReal = await prisma.payroll_runs.findUnique({
    where: { campus_id_period_start_period_end_is_test: { campus_id: CAMPUS_ID, period_start: periodStart, period_end: periodEnd, is_test: false } },
  });
  let createdRealRunForVerification = false;

  console.log('── 1. Generate TEST run scoped to Mirza + Hashir ──');
  const testRun = await payroll.generateRun({ campus_id: CAMPUS_ID, year: YEAR, month: MONTH, employee_ids: [MIRZA_ID, HASHIR_ID] }, user);
  check('run.is_test === true', testRun.is_test === true);
  check('run has exactly 2 lines', testRun.payroll_run_lines?.length === 2, testRun.payroll_run_lines?.length);
  check('run.status === DRAFT', testRun.status === 'DRAFT');
  const mirzaLine = testRun.payroll_run_lines!.find((l: any) => l.employee_id === MIRZA_ID);
  const hashirLine = testRun.payroll_run_lines!.find((l: any) => l.employee_id === HASHIR_ID);
  check('Mirza line present with total_overtime_minutes field', mirzaLine != null && typeof mirzaLine.total_overtime_minutes === 'number', mirzaLine);
  check('Hashir line present with scheduled_minutes_per_day field', hashirLine != null && typeof hashirLine.scheduled_minutes_per_day === 'number', hashirLine);

  console.log('\n── 2. Real run for same campus/period does not collide ──');
  let realRun: any = existingReal;
  if (!existingReal) {
    realRun = await payroll.generateRun({ campus_id: CAMPUS_ID, year: YEAR, month: MONTH }, user);
    createdRealRunForVerification = true;
    check('Real run created without is_test', realRun.is_test === false);
  } else {
    console.log('  (a real run already existed for this period — verifying it is untouched instead of creating one)');
  }
  const realRunBefore = await prisma.payroll_runs.findUnique({ where: { id: realRun.id }, select: { id: true, is_test: true, status: true, generated_at: true } });
  check('Real run and test run are distinct rows', realRun.id !== testRun.id);
  const bothRowsExist = await prisma.payroll_runs.count({
    where: { campus_id: CAMPUS_ID, period_start: periodStart, period_end: periodEnd },
  });
  check('Both a real and a test row exist for the same campus+period', bothRowsExist === 2, bothRowsExist);

  console.log('\n── 3. Finalize the test run ──');
  const finalized = await payroll.finalizeRun(testRun.id, user);
  check('Test run finalized', finalized.status === 'FINALIZED');

  console.log('\n── 4. Settle Mirza with overtime (PER_HOUR) + cash bonus ──');
  const mirzaOvertimeMinutes = mirzaLine!.total_overtime_minutes as number;
  const settledMirza = await payroll.settleLine(
    testRun.id,
    MIRZA_ID,
    { overtime: { rate_type: 'PER_HOUR' as any, rate_amount: 200 }, cash_bonus_amount: 5000, notes: 'verification run' },
    user,
  );
  const mirzaSettlement = (settledMirza as any).payroll_settlements;
  const expectedReward = Math.round((mirzaOvertimeMinutes / 60) * 200 * 100) / 100;
  check('Mirza settlement exists', !!mirzaSettlement);
  check(
    `Mirza overtime_reward_amount ≈ ${expectedReward} (${mirzaOvertimeMinutes}m @ Rs200/hr)`,
    mirzaSettlement && Math.abs(Number(mirzaSettlement.overtime_reward_amount) - expectedReward) < 0.5,
    mirzaSettlement?.overtime_reward_amount,
  );
  check('Mirza cash_bonus_amount === 5000 (admin response only)', mirzaSettlement && Number(mirzaSettlement.cash_bonus_amount) === 5000, mirzaSettlement?.cash_bonus_amount);
  check('Mirza net_paid = net_pay + reward', mirzaSettlement && Math.abs(Number(mirzaSettlement.net_paid) - (Number(settledMirza.net_pay) + Number(mirzaSettlement.overtime_reward_amount))) < 0.01);
  check('Mirza payslip_pdf_url generated', !!mirzaSettlement?.payslip_pdf_url, mirzaSettlement?.payslip_pdf_url);
  console.log('  Mirza payslip URL:', mirzaSettlement?.payslip_pdf_url);
  check('Mirza line.disbursed_at set', !!(settledMirza as any).disbursed_at);

  console.log('\n── 5. Settle Hashir with neither overtime nor bonus ──');
  const settledHashir = await payroll.settleLine(testRun.id, HASHIR_ID, {}, user);
  const hashirSettlement = (settledHashir as any).payroll_settlements;
  check('Hashir overtime_reward_amount === 0', hashirSettlement && Number(hashirSettlement.overtime_reward_amount) === 0, hashirSettlement?.overtime_reward_amount);
  check('Hashir cash_bonus_amount === 0', hashirSettlement && Number(hashirSettlement.cash_bonus_amount) === 0);
  check('Hashir payslip_pdf_url generated', !!hashirSettlement?.payslip_pdf_url, hashirSettlement?.payslip_pdf_url);

  console.log('\n── 6. GET payslip endpoint returns only { pdf_url } — never the cash bonus ──');
  const mirzaPayslip = await payroll.getPayslip(testRun.id, MIRZA_ID, user);
  check('getPayslip(Mirza) matches settlement url', mirzaPayslip.pdf_url === mirzaSettlement.payslip_pdf_url);
  check('getPayslip response has no cash bonus field', !('cash_bonus_amount' in mirzaPayslip));
  const payslipKeys = Object.keys(mirzaPayslip).sort();
  check('getPayslip response is exactly { pdf_url }', JSON.stringify(payslipKeys) === JSON.stringify(['pdf_url']), payslipKeys);

  console.log('\n── 7. Real run untouched throughout ──');
  const realRunAfter = await prisma.payroll_runs.findUnique({ where: { id: realRun.id }, select: { id: true, is_test: true, status: true, generated_at: true } });
  check('Real run row unchanged', JSON.stringify(realRunBefore) === JSON.stringify(realRunAfter), { before: realRunBefore, after: realRunAfter });

  console.log('\n── 8. Regenerate the test run IN PLACE while still finalized ──');
  const regenerated = await payroll.generateRun({ campus_id: CAMPUS_ID, year: YEAR, month: MONTH, employee_ids: [MIRZA_ID, HASHIR_ID] }, user);
  check('Regenerate succeeded without throwing (same run id, back to DRAFT)', regenerated.id === testRun.id && regenerated.status === 'DRAFT', regenerated.status);
  const settlementsAfterRegen = await prisma.payroll_settlements.count({ where: { payroll_run_lines: { payroll_run_id: testRun.id } } });
  check('Old settlements were wiped by the in-place regenerate (fresh snapshot)', settlementsAfterRegen === 0, settlementsAfterRegen);

  console.log('\n── 9. Finalize again, then delete the finalized test run ──');
  await payroll.finalizeRun(testRun.id, user);
  const deleteResult = await payroll.deleteRun(testRun.id, user);
  check('Finalized TEST run was deletable', deleteResult.id === testRun.id);
  const goneRow = await prisma.payroll_runs.findUnique({ where: { id: testRun.id } });
  check('Test run row is actually gone', goneRow === null);

  console.log('\n── 10. Fresh regenerate after full delete ──');
  const freshRun = await payroll.generateRun({ campus_id: CAMPUS_ID, year: YEAR, month: MONTH, employee_ids: [MIRZA_ID, HASHIR_ID] }, user);
  check('Fresh test run created after delete', freshRun.is_test === true && freshRun.id !== testRun.id);

  console.log('\n── 11. Real (non-test) run finalize/delete guard is unchanged ──');
  const attemptDeleteFinalizedReal = await prisma.payroll_runs.findUnique({ where: { id: realRun.id } });
  check('Real run still DRAFT (never finalized by this script)', attemptDeleteFinalizedReal?.status === 'DRAFT');

  if (process.env.SKIP_CLEANUP === '1') {
    console.log('\n── Skipping cleanup (SKIP_CLEANUP=1) — settling freshRun for manual PDF inspection ──');
    await payroll.finalizeRun(freshRun.id, user);
    const s1 = await payroll.settleLine(freshRun.id, MIRZA_ID, { overtime: { rate_type: 'PER_HOUR' as any, rate_amount: 200 }, cash_bonus_amount: 5000 }, user);
    const s2 = await payroll.settleLine(freshRun.id, HASHIR_ID, {}, user);
    console.log('  Mirza payslip URL:', (s1 as any).payroll_settlements.payslip_pdf_url);
    console.log('  Hashir payslip URL:', (s2 as any).payroll_settlements.payslip_pdf_url);
    console.log(`  freshRun.id = ${freshRun.id} (left in place for inspection; delete manually afterwards)`);
    if (createdRealRunForVerification) console.log(`  realRun.id = ${realRun.id} (also left in place — delete manually afterwards)`);
  } else {
    console.log('\n── Cleanup ──');
    await payroll.deleteRun(freshRun.id, user);
    console.log('  Deleted final test run.');
    if (createdRealRunForVerification) {
      await payroll.deleteRun(realRun.id, user);
      console.log('  Deleted the throwaway real DRAFT run created for verification.');
    } else {
      console.log('  Left the pre-existing real run untouched.');
    }
  }

  console.log(`\n${'='.repeat(50)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
  await app.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Verification script crashed:', err);
  process.exit(1);
});
