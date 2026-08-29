/**
 * One-off backfill for the roll-call and staff-expected-time snapshot columns
 * added to stop timetable/teaching-group edits from retroactively relabeling
 * past attendance (see roll-sessions.service.ts create(), and
 * zk-attendance-processor.service.ts upsertStaffDaily()).
 *
 * IMPORTANT: this cannot recover history that was already overwritten before
 * these columns existed. It computes each row's snapshot from the CURRENT
 * live state (teaching_groups / timetable_slots / EmployeeExpectedTimesService)
 * as a best-effort approximation — if that underlying data has already been
 * edited since the attendance was recorded, the backfilled value will be
 * wrong in exactly the same way the display was wrong before this fix. Its
 * only job is to stop further drift from here on, not to undo damage already
 * done.
 *
 * Dry-run by default (prints the report, writes nothing). Pass --apply to
 * actually execute.
 *
 * Usage:
 *   npx ts-node scripts/backfill-attendance-snapshots.ts            # dry run
 *   npx ts-node scripts/backfill-attendance-snapshots.ts --apply    # execute
 */
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { TimetablesModule } from '../src/modules/timetables/timetables.module';
import { EmployeeExpectedTimesService } from '../src/modules/timetables/employee-expected-times.service';
import { AuditLogsModule } from '../src/modules/audit-logs/audit-logs.module';
import { AttendanceSource, ExpectedTimeSource } from '@prisma/client';

@Module({ imports: [PrismaModule, AuditLogsModule, TimetablesModule] })
class BackfillModule {}

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 5; // bounded — this shares a pgbouncer'd pool (limit 17) with live traffic

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function backfillRollSessions(prisma: PrismaService) {
  console.log('\n=== Roll call sessions (subject/teacher snapshot) ===');

  const sessions = await prisma.attendance_roll_sessions.findMany({
    where: {
      snapshot_subject_id: null,
      OR: [{ teaching_group_id: { not: null } }, { timetable_slot_id: { not: null } }],
    },
    select: {
      id: true,
      teaching_group_id: true,
      timetable_slot_id: true,
      teaching_groups: { select: { subject_id: true, employee_id: true } },
      timetable_slots: { select: { subject_id: true, employee_id: true } },
    },
  });

  if (sessions.length === 0) {
    console.log('No roll sessions need backfilling.');
    return;
  }

  console.log(`Found ${sessions.length} roll session(s) with no subject/teacher snapshot.`);
  let updated = 0;
  for (const s of sessions) {
    // Slot is the more specific source when both are present — same
    // precedence as create()'s live resolution.
    const subjectId = s.timetable_slots?.subject_id ?? s.teaching_groups?.subject_id ?? null;
    const employeeId = s.timetable_slots?.employee_id ?? s.teaching_groups?.employee_id ?? null;
    if (subjectId == null && employeeId == null) continue;

    console.log(`  session=${s.id} -> subject_id=${subjectId} employee_id=${employeeId}`);
    if (APPLY) {
      await prisma.attendance_roll_sessions.update({
        where: { id: s.id },
        data: { snapshot_subject_id: subjectId, snapshot_employee_id: employeeId },
      });
    }
    updated++;
  }
  console.log(`${APPLY ? 'Updated' : 'Would update'} ${updated} roll session(s).`);
}

async function backfillStaffDaily(prisma: PrismaService, expectedTimes: EmployeeExpectedTimesService) {
  console.log('\n=== Staff daily attendance (expected-time snapshot) ===');

  const rows = await prisma.attendance_staff_daily.findMany({
    where: {
      expected_check_in_snapshot: null,
      source: { in: [AttendanceSource.BIOMETRIC, AttendanceSource.SYSTEM] },
    },
    select: { id: true, employee_id: true, campus_id: true, date: true },
  });

  if (rows.length === 0) {
    console.log('No staff daily rows need backfilling.');
    return;
  }

  console.log(`Found ${rows.length} staff daily row(s) with no expected-time snapshot.`);
  console.log(`Processing with concurrency=${CONCURRENCY}...`);

  let updated = 0;
  let skipped = 0;
  let processed = 0;
  let failed = 0;
  const sourceCounts = new Map<string, number>();

  // This DB connection has been flaky under sustained concurrent load (pool
  // exhaustion, transient "can't reach server"). Retry each row a few times
  // with backoff rather than letting one blip abort the whole run — failures
  // are logged and counted, not silently dropped, so a final targeted re-run
  // (the query is re-run-safe) can mop up anything still failing.
  async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
    throw new Error('unreachable');
  }

  await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    try {
      const resolved = await withRetry(() =>
        expectedTimes.resolveExpectedTimes(row.employee_id, row.campus_id, row.date),
      );
      processed++;
      if (processed % 500 === 0) console.log(`  ...${processed}/${rows.length} processed`);

      if (!resolved.expectedCheckIn && !resolved.expectedCheckOut) {
        skipped++;
        return;
      }
      sourceCounts.set(resolved.source, (sourceCounts.get(resolved.source) ?? 0) + 1);

      if (APPLY) {
        await withRetry(() =>
          prisma.attendance_staff_daily.update({
            where: { id: row.id },
            data: {
              expected_check_in_snapshot: resolved.expectedCheckIn,
              expected_check_out_snapshot: resolved.expectedCheckOut,
              expected_grace_minutes_snapshot: resolved.graceMinutes,
              expected_time_source_snapshot: resolved.source as ExpectedTimeSource,
            },
          }),
        );
      }
      updated++;
    } catch (err) {
      failed++;
      console.error(
        `  FAILED employee=${row.employee_id} date=${row.date.toISOString().slice(0, 10)}: ${(err as Error).message}`,
      );
    }
  });

  console.log(`${APPLY ? 'Updated' : 'Would update'} ${updated} staff daily row(s) (${skipped} had no resolvable expected time, ${failed} failed after retries).`);
  console.log('By source:', Object.fromEntries(sourceCounts));
  if (failed > 0) {
    console.log(`\n${failed} row(s) failed after retries — re-run this script (safe/idempotent) to retry them.`);
  }
}

async function main() {
  const app = await NestFactory.createApplicationContext(BackfillModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const expectedTimes = app.get(EmployeeExpectedTimesService);

  console.log(`Mode: ${APPLY ? 'APPLY (writes will happen)' : 'DRY RUN (no writes)'}`);

  await backfillRollSessions(prisma);
  await backfillStaffDaily(prisma, expectedTimes);

  if (!APPLY) {
    console.log('\nDry run only — re-run with --apply to execute.');
  }

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
