/**
 * One-off backfill for the 26 Jul – 25 Aug payroll cycle: staff repeatedly
 * scanned the biometric device to make sure it registered, and some (e.g.
 * guards on a long continuous shift) also get extra incidental scans through
 * the day that were never meant to mark a break. Payroll pairs scans IN/OUT
 * by index, so a person with more than 2 scans in a day gets any scan after
 * the first read as OUT and the next as IN again — turning ordinary mid-shift
 * activity into a bogus multi-hour BREAK and a real pay deduction (confirmed
 * on IRFAN ALI / GKF-06-0001, 2026-07-27: scans at 06:17, 07:24, 16:00, 18:34
 * were read as a 516-minute break and deducted ~Rs 10,760 — he was on shift
 * the whole time).
 *
 * NOTE: an earlier version of this script only merged scans within a 15-
 * minute window of each other, on the theory that widely-spaced extra scans
 * were legitimate lunch/break punches. The above case disproves that for
 * this organization — extra scans, however spaced out, are not meant to
 * split the shift. This version goes back to the originally requested fix:
 * for every day with more than 2 scans, keep only the very first and very
 * last, regardless of the gaps between them.
 *
 * Operates on ALL scans for the day (not just currently-non-duplicate ones),
 * so it's safe to re-run after the earlier narrower pass — the first/last
 * scan of each day is explicitly kept (is_duplicate = false) and everything
 * else explicitly excluded (is_duplicate = true), superseding any previous
 * partial exclusion. Rows are never deleted — reversible, audit trail kept.
 *
 * Dry-run by default (prints the report, writes nothing). Pass --apply to
 * actually execute.
 *
 * Usage:
 *   npx ts-node scripts/backfill-collapse-multi-punch-days.ts            # dry run
 *   npx ts-node scripts/backfill-collapse-multi-punch-days.ts --apply    # execute
 *
 * Override the date range with env vars (defaults to the 26 Jul – 25 Aug
 * 2026 cycle):
 *   BACKFILL_START=2026-07-26 BACKFILL_END=2026-08-25 npx ts-node ...
 */
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceModule } from '../src/modules/attendance/attendance.module';
import { AuditLogsModule } from '../src/modules/audit-logs/audit-logs.module';
import { ZkAttendanceProcessorService } from '../src/modules/attendance/zk-attendance-processor.service';
import { computePayrollWindow } from '../src/modules/hr/payroll/payroll-period.util';
import { DevicePersonType } from '@prisma/client';

@Module({ imports: [PrismaModule, AuditLogsModule, AttendanceModule] })
class BackfillModule {}

const START = process.env.BACKFILL_START ?? '2026-07-26';
const END = process.env.BACKFILL_END ?? '2026-08-25';
const APPLY = process.argv.includes('--apply');

function toUtcDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

async function main() {
  const app = await NestFactory.createApplicationContext(BackfillModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const processor = app.get(ZkAttendanceProcessorService);

  const startDate = toUtcDate(START);
  const endDate = toUtcDate(END);

  console.log(`Range: ${START} – ${END} (STAFF only)`);
  console.log(`Mode: ${APPLY ? 'APPLY (writes will happen)' : 'DRY RUN (no writes)'}\n`);

  // ── Report step: is there already a payroll run covering this period? ──
  const { periodStart, periodEnd } = computePayrollWindow(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth() + 1,
  );
  const existingRuns = await prisma.payroll_runs.findMany({
    where: { period_start: periodStart, period_end: periodEnd, is_test: false },
    select: { id: true, campus_id: true, status: true, generated_at: true },
  });
  if (existingRuns.length > 0) {
    console.log(`⚠ ${existingRuns.length} payroll run(s) already exist for this period:`);
    for (const r of existingRuns) {
      console.log(`  run ${r.id} campus=${r.campus_id} status=${r.status} generated_at=${r.generated_at.toISOString()}`);
    }
    console.log('  Their cached daily_breakdown/deductions are a stale snapshot from before this');
    console.log('  backfill — use the existing "Regenerate" action in the payroll UI afterward.\n');
  } else {
    console.log('No payroll run exists yet for this period — nothing to regenerate.\n');
  }

  // ── Find affected person-days (ALL scans, not just currently-non-duplicate ones) ──
  const scans = await prisma.zk_attendance_scans.findMany({
    where: {
      person_type: DevicePersonType.STAFF,
      attendance_date: { gte: startDate, lte: endDate },
    },
    select: { id: true, employee_id: true, attendance_date: true, scan_time: true, is_duplicate: true },
    orderBy: [{ employee_id: 'asc' }, { attendance_date: 'asc' }, { scan_time: 'asc' }],
  });

  type Scan = (typeof scans)[number];
  type Group = { employeeId: number; date: Date; scans: Scan[] };
  const groups = new Map<string, Group>();
  for (const s of scans) {
    if (s.employee_id == null) continue;
    const key = `${s.employee_id}:${s.attendance_date.toISOString()}`;
    const g = groups.get(key);
    if (g) g.scans.push(s);
    else groups.set(key, { employeeId: s.employee_id, date: s.attendance_date, scans: [s] });
  }

  const affected = [...groups.values()].filter((g) => g.scans.length > 2);

  if (affected.length === 0) {
    console.log('No person-days with more than 2 scans found — nothing to backfill.');
    await app.close();
    return;
  }

  console.log(`Found ${affected.length} affected person-day(s):`);
  let totalExcluded = 0;
  let alreadyCorrect = 0;
  for (const g of affected) {
    const first = g.scans[0];
    const last = g.scans[g.scans.length - 1];
    const middle = g.scans.slice(1, -1);
    const needsChange =
      middle.some((s) => !s.is_duplicate) || first.is_duplicate || last.is_duplicate;
    if (!needsChange) {
      alreadyCorrect++;
      continue;
    }
    totalExcluded += middle.length;
    console.log(
      `  employee=${g.employeeId} date=${g.date.toISOString().slice(0, 10)} scans=${g.scans.length} ` +
        `(keeping first ${first.scan_time.toISOString()} + last ${last.scan_time.toISOString()}, ` +
        `excluding ${middle.length})`,
    );
  }
  console.log(`\nTotal scans to soft-exclude: ${totalExcluded} (${alreadyCorrect} day(s) already correctly first+last from the earlier pass)`);

  if (!APPLY) {
    console.log('\nDry run only — re-run with --apply to execute.');
    await app.close();
    return;
  }

  console.log('\nApplying...');
  let daysTouched = 0;
  const outcomeCounts = new Map<string, number>();
  for (const g of affected) {
    const first = g.scans[0];
    const last = g.scans[g.scans.length - 1];
    const middleIds = g.scans.slice(1, -1).map((s) => s.id);

    const needsChange = g.scans.slice(1, -1).some((s) => !s.is_duplicate) || first.is_duplicate || last.is_duplicate;
    if (!needsChange) continue;

    await prisma.$transaction([
      prisma.zk_attendance_scans.updateMany({ where: { id: { in: middleIds } }, data: { is_duplicate: true } }),
      prisma.zk_attendance_scans.update({ where: { id: first.id }, data: { is_duplicate: false } }),
      prisma.zk_attendance_scans.update({ where: { id: last.id }, data: { is_duplicate: false } }),
    ]);

    const outcome = await processor.recomputePersonDay(
      DevicePersonType.STAFF,
      g.employeeId,
      null,
      g.date,
      { actor: 'backfill-collapse-multi-punch-days', recomputeDuplicates: false },
    );
    outcomeCounts.set(outcome.action, (outcomeCounts.get(outcome.action) ?? 0) + 1);
    if (outcome.action !== 'UPSERTED') {
      console.log(`  employee=${g.employeeId} date=${g.date.toISOString().slice(0, 10)} -> ${outcome.action} (worth a look)`);
    }
    daysTouched++;
  }

  console.log(`\nDone. ${daysTouched} day(s) touched, ${totalExcluded} scan(s) soft-excluded.`);
  console.log('Outcomes:', Object.fromEntries(outcomeCounts));
  if (existingRuns.length > 0) {
    console.log('\nRemember: regenerate the affected employees\' lines on the existing payroll run(s) listed above.');
  }

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
