/**
 * One-off backfill for the 26 Jul – 25 Aug payroll cycle: staff sometimes
 * scanned the biometric device more than once within a couple of minutes,
 * unsure the first one had registered. Payroll pairs scans IN/OUT by index,
 * so a stray close-together scan can read as a spurious few-minute BREAK.
 *
 * IMPORTANT: an earlier version of this script collapsed every multi-scan
 * day down to just its first and last punch. A dry run showed that's wrong —
 * most "extra" scans on a given day are hours apart (gate-in, break-out,
 * break-in, gate-out), i.e. real activity, not device anxiety. This version
 * only merges scans that land within WINDOW_MS of the previous *kept* scan
 * for that person-day — the same "gap since last accepted scan" rule the
 * codebase already uses for its always-on 2-minute dedup window
 * (zk-attendance-processor.service.ts DEDUP_WINDOW_MS / recomputeDayDuplicates),
 * just widened for this one-off cleanup pass. Scans genuinely spread through
 * the day are left completely alone.
 *
 * For every cluster of near-duplicate scans, only the first scan in the
 * cluster is kept; the rest are soft-excluded (is_duplicate = true — rows
 * are never deleted, so the audit trail is kept and it's fully reversible).
 * The affected day's attendance_staff_daily row is then rebuilt from the
 * surviving scans.
 *
 * Dry-run by default (prints the report, writes nothing). Pass --apply to
 * actually execute.
 *
 * Usage:
 *   npx ts-node scripts/backfill-collapse-near-duplicate-punches.ts            # dry run
 *   npx ts-node scripts/backfill-collapse-near-duplicate-punches.ts --apply    # execute
 *
 * Override the date range or window with env vars (defaults to the
 * 26 Jul – 25 Aug 2026 cycle and a 15-minute clustering window):
 *   BACKFILL_START=2026-07-26 BACKFILL_END=2026-08-25 BACKFILL_WINDOW_MIN=15 npx ts-node ...
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
const WINDOW_MS = (Number(process.env.BACKFILL_WINDOW_MIN) || 15) * 60 * 1000;
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
  console.log(`Clustering window: ${WINDOW_MS / 60000} minute(s)`);
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

  // ── Find affected person-days ──
  const scans = await prisma.zk_attendance_scans.findMany({
    where: {
      person_type: DevicePersonType.STAFF,
      is_duplicate: false,
      attendance_date: { gte: startDate, lte: endDate },
    },
    select: { id: true, employee_id: true, attendance_date: true, scan_time: true },
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

  // Cluster each day's scans by gap-since-last-kept-scan, same rule as the
  // codebase's own recomputeDayDuplicates, just with a wider window.
  function clusterExcludes(dayScans: Scan[]): Scan[] {
    const excluded: Scan[] = [];
    let lastKept: Scan | null = null;
    for (const s of dayScans) {
      if (lastKept && s.scan_time.getTime() - lastKept.scan_time.getTime() < WINDOW_MS) {
        excluded.push(s);
      } else {
        lastKept = s;
      }
    }
    return excluded;
  }

  const affected: { group: Group; excluded: Scan[] }[] = [];
  for (const g of groups.values()) {
    if (g.scans.length < 2) continue;
    const excluded = clusterExcludes(g.scans);
    if (excluded.length > 0) affected.push({ group: g, excluded });
  }

  if (affected.length === 0) {
    console.log('No near-duplicate scans found within the clustering window — nothing to backfill.');
    await app.close();
    return;
  }

  console.log(`Found ${affected.length} affected person-day(s):`);
  let totalExcluded = 0;
  for (const { group: g, excluded } of affected) {
    totalExcluded += excluded.length;
    const excludedIds = new Set(excluded.map((s) => s.id));
    const kept = g.scans.filter((s) => !excludedIds.has(s.id));
    console.log(
      `  employee=${g.employeeId} date=${g.date.toISOString().slice(0, 10)} scans=${g.scans.length} -> keeping ${kept.length} ` +
        `[${kept.map((s) => s.scan_time.toISOString().slice(11, 19)).join(', ')}], ` +
        `excluding ${excluded.length} [${excluded.map((s) => s.scan_time.toISOString().slice(11, 19)).join(', ')}]`,
    );
  }
  console.log(`\nTotal scans to soft-exclude: ${totalExcluded}`);

  if (!APPLY) {
    console.log('\nDry run only — re-run with --apply to execute.');
    await app.close();
    return;
  }

  console.log('\nApplying...');
  let daysTouched = 0;
  const outcomeCounts = new Map<string, number>();
  for (const { group: g, excluded } of affected) {
    await prisma.zk_attendance_scans.updateMany({
      where: { id: { in: excluded.map((s) => s.id) } },
      data: { is_duplicate: true },
    });

    const outcome = await processor.recomputePersonDay(
      DevicePersonType.STAFF,
      g.employeeId,
      null,
      g.date,
      { actor: 'backfill-collapse-near-duplicate-punches', recomputeDuplicates: false },
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
