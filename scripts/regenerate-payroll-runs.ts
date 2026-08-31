/**
 * Regenerates every employee line on a given set of payroll runs, reusing
 * the exact same PayrollService#regenerateLine path the "Regenerate" button
 * in the UI calls per employee. Used here to refresh the DRAFT runs already
 * generated for the 26 Jul – 25 Aug cycle after backfill-collapse-multi-punch-days.ts
 * corrected the underlying biometric scans.
 *
 * Skips (and reports) lines that are already finalized or excluded —
 * regenerateLine itself refuses those, this just avoids noisy errors.
 *
 * Usage: npx ts-node scripts/regenerate-payroll-runs.ts <runId> [runId...]
 *   e.g. npx ts-node scripts/regenerate-payroll-runs.ts 55 56 57
 */
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HrModule } from '../src/modules/hr/hr.module';
import { AuditLogsModule } from '../src/modules/audit-logs/audit-logs.module';
import { PayrollService } from '../src/modules/hr/payroll/payroll.service';
import { PrismaService } from '../prisma/prisma.service';
import type { IJwtStaffPayload } from '../src/modules/auth/interfaces/jwt-payload.interface';

@Module({ imports: [PrismaModule, AuditLogsModule, HrModule] })
class RegenModule {}

const RUN_IDS = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));

async function main() {
  if (RUN_IDS.length === 0) {
    console.error('Usage: npx ts-node scripts/regenerate-payroll-runs.ts <runId> [runId...]');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(RegenModule, { logger: ['error', 'warn'] });
  const payroll = app.get(PayrollService);
  const prisma = app.get(PrismaService);

  // This script's process has much higher round-trip latency to the DB than
  // the deployed backend does, so Prisma's default 5s interactive-transaction
  // timeout was tripping mid-regenerate even with pacing between calls.
  // Widen it for this one-off run only — the running server's own PrismaClient
  // (and its default timeout) is untouched.
  const originalTransaction = prisma.$transaction.bind(prisma);
  (prisma as any).$transaction = (arg: any, options?: any) =>
    Array.isArray(arg)
      ? originalTransaction(arg, { timeout: 30000, ...options })
      : originalTransaction(arg, { timeout: 30000, maxWait: 10000, ...options });

  const adminUserRow = await prisma.users.findFirst({ where: { is_active: true }, select: { id: true, username: true } });
  if (!adminUserRow) throw new Error('No active user found to act as the regenerating admin.');
  const user: IJwtStaffPayload = {
    sub: adminUserRow.id,
    username: adminUserRow.username,
    role: 'SUPER_ADMIN' as any,
    campusId: null,
    allowedClassIds: [],
    userType: 'STAFF',
    permissions: ['*'],
  };
  console.log(`Acting as ${adminUserRow.username} (${adminUserRow.id})\n`);

  for (const runId of RUN_IDS) {
    const lines = await prisma.payroll_run_lines.findMany({
      where: { payroll_run_id: runId },
      select: { employee_id: true },
    });
    console.log(`Run ${runId}: ${lines.length} line(s)`);

    let ok = 0, skipped = 0, failed = 0;
    const failedIds: number[] = [];
    for (const { employee_id } of lines) {
      try {
        await payroll.regenerateLine(runId, employee_id, user);
        ok++;
      } catch (err: any) {
        const msg = (err?.message ?? String(err)).split('\n')[0];
        if (msg.includes('finalized') || msg.includes('excluded')) {
          skipped++;
        } else {
          failed++;
          failedIds.push(employee_id);
          console.log(`  employee=${employee_id} FAILED: ${msg}`);
        }
      }
      // Small pause between employees — remote DB latency was causing the
      // 5s interactive-transaction timeout to trip under back-to-back load.
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log(`  regenerated=${ok} skipped=${skipped} failed=${failed}`);
    if (failedIds.length > 0) console.log(`  failed ids: ${failedIds.join(', ')}`);
    console.log('');
  }

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
