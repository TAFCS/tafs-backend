/**
 * One-off: morning punches on 2026-09-12 that never reached the server.
 * The evening punch for each person below is already stored; the morning one
 * is not. Inserts the missing scans (is_live=false, so no parent/staff
 * notification is sent) and recomputes each affected person-day through the
 * processor so direction/sequence and the daily row follow.
 *
 * Times come from a manual list with minute precision only, so seconds are :00.
 * All PINs are filed under device NYU7261205040 (GKF Faculty) — the same device that holds
 * each person's existing evening scan. (PINs 40001/40002/60001 also exist on
 * NYU7261000023 for different employees; those are not touched.)
 *
 * Dry-run by default. Idempotent: re-running skips scans that already exist.
 *   npx ts-node scripts/backfill-missing-morning-punches-2026-09-12.ts
 *   npx ts-node scripts/backfill-missing-morning-punches-2026-09-12.ts --apply
 */
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeModule } from '../src/common/scope/scope.module';
import { AuditLogsModule } from '../src/modules/audit-logs/audit-logs.module';
import { AttendanceModule } from '../src/modules/attendance/attendance.module';
import { ZkAttendanceProcessorService } from '../src/modules/attendance/zk-attendance-processor.service';
import { DevicePersonType } from '@prisma/client';

@Module({ imports: [PrismaModule, ScopeModule, AuditLogsModule, AttendanceModule] })
class BackfillModule {}

const APPLY = process.argv.includes('--apply');
const DEVICE_SN = 'NYU7261205040';
const DATE = '2026-09-12';
const ACTOR = 'script:backfill-missing-morning-punches-2026-09-12';

const PUNCHES: { pin: string; time: string }[] = [
  { pin: '60001', time: '05:52' },
  { pin: '2001240', time: '08:19' },
  { pin: '30001', time: '08:54' },
  { pin: '40003', time: '06:59' },
  { pin: '40002', time: '07:16' },
  { pin: '40001', time: '07:05' },
  { pin: '200023', time: '07:30' },
  { pin: '200025', time: '07:21' },
  { pin: '200020', time: '07:36' },
  { pin: '200019', time: '08:44' },
  { pin: '200024', time: '07:30' },
  { pin: '200010', time: '07:30' },
  { pin: '200028', time: '07:21' },
  { pin: '200018', time: '07:46' },
  { pin: '200015', time: '07:36' },
];

async function main() {
  const app = await NestFactory.createApplicationContext(BackfillModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const processor = app.get(ZkAttendanceProcessorService);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}  date=${DATE}  device=${DEVICE_SN}\n`);

  const date = new Date(`${DATE}T00:00:00.000Z`);
  const days = new Map<string, { type: DevicePersonType; employeeId: number | null; studentCc: number | null }>();
  let inserted = 0;

  for (const p of PUNCHES) {
    const scanTime = new Date(`${DATE}T${p.time}:00.000Z`);
    const m = await prisma.device_user_mappings.findUnique({
      where: { device_sn_device_pin: { device_sn: DEVICE_SN, device_pin: p.pin } },
    });
    if (m && m.person_type !== DevicePersonType.STAFF) { console.log(`SKIP  pin ${p.pin}: mapped to a ${m.person_type}, faculty punches only`); continue; }
    if (!m || !m.is_active) { console.log(`SKIP  pin ${p.pin}: no active mapping`); continue; }

    const existing = await prisma.zk_attendance_scans.findUnique({
      where: { device_sn_device_pin_scan_time: { device_sn: DEVICE_SN, device_pin: p.pin, scan_time: scanTime } },
    });
    const who = `${m.person_type} ${m.employee_id ?? m.student_cc} ${m.display_name ?? ''}`.trim();
    if (existing) { console.log(`EXISTS pin ${p.pin} ${p.time}  ${who}`); continue; }

    const dayScans = await prisma.zk_attendance_scans.findMany({
      where: { device_sn: DEVICE_SN, device_pin: p.pin, attendance_date: date },
      select: { scan_time: true },
      orderBy: { scan_time: 'asc' },
    });
    console.log(
      `ADD   pin ${p.pin} ${p.time}  ${who}  (existing: ${dayScans.map((s) => s.scan_time.toISOString().slice(11, 16)).join(', ') || 'none'})`,
    );

    if (APPLY) {
      await prisma.zk_attendance_scans.create({
        data: {
          device_sn: DEVICE_SN,
          device_pin: p.pin,
          person_type: m.person_type,
          employee_id: m.employee_id ?? undefined,
          student_cc: m.student_cc ?? undefined,
          scan_time: scanTime,
          attendance_date: date,
          is_duplicate: false,
          is_live: false,
        },
      });
    }
    inserted++;
    days.set(p.pin, { type: m.person_type, employeeId: m.employee_id, studentCc: m.student_cc });
  }

  // Flag staff who were marked EXCUSED/Weekend by the system yet punched in on the day.
  // The processor never overwrites SYSTEM rows, so these stay as they are.
  const flagged = await prisma.attendance_staff_daily.findMany({
    where: {
      date,
      employee_id: { in: [...days.values()].map((d) => d.employeeId!).filter(Boolean) },
      source: 'SYSTEM',
      status: 'EXCUSED',
    },
    select: { employee_id: true, notes: true, employee_profiles: { select: { full_name: true, employee_code: true } } },
  });
  console.log(`\nFLAG: ${flagged.length} staff have a system "${'EXCUSED'}" day but punched in on ${DATE}:`);
  for (const f of flagged) {
    const pin = [...days.entries()].find(([, d]) => d.employeeId === f.employee_id)?.[0];
    console.log(`  employee ${f.employee_id} ${f.employee_profiles.employee_code ?? ''} ${f.employee_profiles.full_name}  pin ${pin}  note="${f.notes}"`);
  }

  if (APPLY) {
    console.log('\nRecomputing days...');
    for (const [pin, d] of days) {
      const o = await processor.recomputePersonDay(d.type, d.employeeId, d.studentCc, date, { actor: ACTOR });
      console.log(`  pin ${pin}: ${o.statusBefore ?? '-'} -> ${o.statusAfter ?? '-'}  ${o.action}`);
    }
  }
  console.log(`\n${APPLY ? 'Inserted' : 'Would insert'} ${inserted} scan(s).`);
  if (!APPLY) console.log('Dry run only — re-run with --apply.');
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
