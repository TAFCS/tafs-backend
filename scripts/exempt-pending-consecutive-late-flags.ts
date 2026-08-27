/**
 * One-off cleanup for disabling the 3-consecutive-late payroll rule.
 *
 * `PayrollService.detectPayrollFlags` no longer generates new CONSECUTIVE_LATE
 * flags (see the CONSECUTIVE_LATE_RULE_ENABLED toggle in payroll.service.ts),
 * but any flags it already generated before the toggle flipped are still
 * sitting PENDING on their runs, which blocks finalizeLine. This marks every
 * still-PENDING CONSECUTIVE_LATE flag EXEMPTED (never deletes rows, so the
 * audit trail — who/when it was decided — is preserved).
 *
 * EXEMPTED flags never contribute to consecutive_late_deduction (only
 * APPLIED flags are summed in recomputeLineFlagDeductions), so this cannot
 * change any employee's pay — it only unblocks finalization.
 *
 * Usage: npx ts-node scripts/exempt-pending-consecutive-late-flags.ts
 */
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

@Module({ imports: [PrismaModule] })
class CleanupModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(CleanupModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);

  const pending = await prisma.payroll_flags.findMany({
    where: { flag_type: 'CONSECUTIVE_LATE', status: 'PENDING' },
    select: { id: true, payroll_run_id: true, employee_id: true, anchor_date: true, deduction_days: true },
  });

  if (pending.length === 0) {
    console.log('No PENDING CONSECUTIVE_LATE flags found — nothing to do.');
    await app.close();
    return;
  }

  console.log(`Found ${pending.length} PENDING CONSECUTIVE_LATE flag(s):`);
  const byRun = new Map<number, number>();
  for (const f of pending) {
    byRun.set(f.payroll_run_id, (byRun.get(f.payroll_run_id) ?? 0) + 1);
    console.log(
      `  run=${f.payroll_run_id} employee=${f.employee_id} anchor=${f.anchor_date.toISOString().slice(0, 10)} days=${f.deduction_days}`,
    );
  }
  console.log('\nBy run:');
  for (const [runId, count] of byRun) console.log(`  run ${runId}: ${count} flag(s)`);

  const result = await prisma.payroll_flags.updateMany({
    where: { flag_type: 'CONSECUTIVE_LATE', status: 'PENDING' },
    data: {
      status: 'EXEMPTED',
      decided_by: 'system:consecutive-late-rule-disabled',
      decided_at: new Date(),
    },
  });

  console.log(`\nExempted ${result.count} flag(s). No pay figures changed (only APPLIED flags affect deductions).`);

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
