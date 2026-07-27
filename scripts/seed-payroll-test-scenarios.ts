/**
 * Seeds a full set of dummy attendance scenarios for the two payroll test
 * employees (Hashir Khan / TEST-HASHIR-001 and Muhammad Hassan Mirza /
 * GEJ-08-6969) across one payroll cycle, so every payroll rule can be
 * exercised end-to-end from the admin panel: 3-consecutive-lates, the
 * sandwich rule, isolated lates, overtime, late-but-within-grace, breaks,
 * leaving early, a 2-day late streak that breaks before hitting 3, and a
 * genuine shift-override day.
 *
 * Idempotent: wipes this cycle's attendance/scan/calendar-override data for
 * both employees first, then rebuilds it from scratch. Safe to re-run.
 *
 * Run with: npx ts-node -r tsconfig-paths/register scripts/seed-payroll-test-scenarios.ts
 */
import { PrismaClient, AttendanceSource, StaffAttendanceStatus, ScanDirection } from '@prisma/client';

const prisma = new PrismaClient();

const CAMPUS_ID = 1;
const PERIOD_START = '2026-06-26';
const PERIOD_END = '2026-07-25';

const HASHIR_CODE = 'TEST-HASHIR-001';
const HASSAN_CODE = 'GEJ-08-6969';

const HASHIR_DEVICE = { sn: 'NYU7251000240', pin: '8889' };
const HASSAN_DEVICE = { sn: 'NYU7251000240', pin: '8888' };

function d(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function t(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00.000Z`);
}

type Scan = { time: Date; direction: ScanDirection };

interface DayPlan {
  date: string;
  kind: 'SCANS' | 'ABSENT' | 'HOLIDAY';
  scans?: Scan[];
  note: string;
}

function scanDay(date: string, punches: string[], note: string): DayPlan {
  return {
    date,
    kind: 'SCANS',
    scans: punches.map((hhmm, i) => ({ time: t(date, hhmm), direction: i % 2 === 0 ? ScanDirection.IN : ScanDirection.OUT })),
    note,
  };
}

function absentDay(date: string, note: string): DayPlan {
  return { date, kind: 'ABSENT', note };
}

function holidayDay(date: string, note: string): DayPlan {
  return { date, kind: 'HOLIDAY', note };
}

// ── Hashir Khan: reporting 08:00, leaving 14:00, grace 0min ────────────────
const HASHIR_PLAN: DayPlan[] = [
  scanDay('2026-06-26', ['07:55', '15:30'], 'Overtime — worked 1.5h past 14:00 leaving time'),

  scanDay('2026-06-29', ['08:20', '14:00'], '3-consecutive-late day 1/3 (20m late)'),
  scanDay('2026-06-30', ['08:15', '14:00'], '3-consecutive-late day 2/3 (15m late)'),
  scanDay('2026-07-01', ['08:10', '14:00'], '3-consecutive-late day 3/3 (10m late) — should flag CONSECUTIVE_LATE'),
  scanDay('2026-07-02', ['07:58', '14:00'], 'On time — breaks the late streak'),
  scanDay('2026-07-03', ['07:55', '11:00', '11:30', '14:00'], 'Breaks in between — 30min break mid-shift'),

  scanDay('2026-07-06', ['08:00', '13:00'], 'Leaving early — checked out 1h before 14:00'),
  scanDay('2026-07-07', ['08:12', '14:00'], 'Generally late (isolated, 12m late)'),
  scanDay('2026-07-08', ['07:57', '14:00'], 'On time'),
  scanDay('2026-07-09', ['08:09', '14:00'], 'Generally late (isolated, 9m late)'),
  scanDay('2026-07-10', ['08:14', '14:00'], '2-day-late streak day 1/2 (14m late)'),
  scanDay('2026-07-11', ['07:58', '14:00'], 'Mandatory Saturday (TEACHER category) — on time'),

  scanDay('2026-07-13', ['08:11', '14:00'], '2-day-late streak day 2/2 (11m late) — should NOT flag (only 2, not 3)'),
  scanDay('2026-07-14', ['07:59', '14:00'], 'On time — breaks the 2-day streak'),
  absentDay('2026-07-15', 'Sandwich bracket-before — absent the working day before the holiday block'),
  holidayDay('2026-07-16', 'Sandwich holiday block day 1/2'),
  holidayDay('2026-07-17', 'Sandwich holiday block day 2/2'),
  // This mandatory Saturday is the actual nearest working day after the
  // holiday block (it's a real working day for this TEACHER-category
  // employee, not a normal weekend) — it has to be non-worked too for the
  // sandwich condition to hold, otherwise the rule correctly does NOT fire.
  absentDay('2026-07-18', 'Sandwich bracket-after (mandatory Saturday) — absent, completes the flag'),

  absentDay('2026-07-20', 'Also absent — reinforces the post-holiday absence run'),
  scanDay('2026-07-21', ['07:50', '11:00', '11:20', '16:00'], 'Overtime + a break in the same day'),
  { date: '2026-07-22', kind: 'SCANS', note: 'Shift-override day — early shift 06:00-12:00, on time for that shift', scans: [
    { time: t('2026-07-22', '05:58'), direction: ScanDirection.IN },
    { time: t('2026-07-22', '12:00'), direction: ScanDirection.OUT },
  ] },
  scanDay('2026-07-23', ['07:59', '14:05'], 'Normal on-time day'),
  scanDay('2026-07-24', ['08:00', '14:00'], 'Normal on-time day'),
];
const HASHIR_SHIFT_OVERRIDES: { date: string; start: string; end: string; reason: string }[] = [
  { date: '2026-07-22', start: '06:00', end: '12:00', reason: '[TEST DATA] Early shift override' },
];

// ── Muhammad Hassan Mirza: reporting 08:25, leaving 17:30, grace 10min ─────
const HASSAN_PLAN: DayPlan[] = [
  scanDay('2026-06-26', ['08:32', '17:30'], 'Late but within the 10-minute grace (7m late) — should NOT count as late'),

  scanDay('2026-06-29', ['08:50', '17:30'], '3-consecutive-late day 1/3 (25m late)'),
  scanDay('2026-06-30', ['08:45', '17:30'], '3-consecutive-late day 2/3 (20m late)'),
  scanDay('2026-07-01', ['08:40', '17:30'], '3-consecutive-late day 3/3 (15m late) — should flag CONSECUTIVE_LATE'),
  scanDay('2026-07-02', ['08:20', '17:30'], 'On time — breaks the late streak'),
  scanDay('2026-07-03', ['08:20', '19:00'], 'Overtime — worked 1.5h past 17:30 leaving time'),

  scanDay('2026-07-06', ['08:20', '12:00', '12:45', '17:30'], 'Breaks in between — 45min lunch break'),
  scanDay('2026-07-07', ['08:25', '16:00'], 'Leaving early — checked out 1.5h before 17:30'),
  scanDay('2026-07-08', ['08:50', '17:30'], 'Generally late (isolated, 25m late)'),
  scanDay('2026-07-09', ['08:22', '17:30'], 'On time'),
  scanDay('2026-07-10', ['08:45', '17:30'], '2-day-late streak day 1/2 (20m late)'),

  scanDay('2026-07-13', ['08:40', '17:30'], '2-day-late streak day 2/2 (15m late) — should NOT flag (only 2, not 3)'),
  scanDay('2026-07-14', ['08:20', '17:30'], 'On time — breaks the 2-day streak'),
  absentDay('2026-07-15', 'Sandwich bracket-before — absent the working day before the holiday block'),
  holidayDay('2026-07-16', 'Sandwich holiday block day 1/2'),
  holidayDay('2026-07-17', 'Sandwich holiday block day 2/2'),

  absentDay('2026-07-20', 'Sandwich bracket-after — absent the working day after the holiday block, completes the flag'),
  scanDay('2026-07-21', ['08:22', '17:35'], 'Normal on-time day'),
  { date: '2026-07-22', kind: 'SCANS', note: 'Shift-override day — second shift 10:00-18:00, on time for that shift', scans: [
    { time: t('2026-07-22', '10:00'), direction: ScanDirection.IN },
    { time: t('2026-07-22', '18:00'), direction: ScanDirection.OUT },
  ] },
  scanDay('2026-07-23', ['08:24', '17:30'], 'Normal on-time day'),
  scanDay('2026-07-24', ['08:20', '17:32'], 'Normal on-time day'),
];
const HASSAN_SHIFT_OVERRIDES: { date: string; start: string; end: string; reason: string }[] = [
  { date: '2026-07-22', start: '10:00', end: '18:00', reason: '[TEST DATA] Second-shift override' },
];

function isLate(checkIn: Date, reportingTime: Date, graceMinutes: number): boolean {
  const reportingMinutes = reportingTime.getUTCHours() * 60 + reportingTime.getUTCMinutes();
  const checkInMinutes = checkIn.getUTCHours() * 60 + checkIn.getUTCMinutes();
  return checkInMinutes > reportingMinutes + graceMinutes;
}

async function seedEmployee(
  employeeCode: string,
  plan: DayPlan[],
  overrides: { date: string; start: string; end: string; reason: string }[],
  device: { sn: string; pin: string },
  adminId: string,
) {
  const employee = await prisma.employee_profiles.findFirst({ where: { employee_code: employeeCode } });
  if (!employee) throw new Error(`${employeeCode} not found — aborting.`);

  console.log(`\n== ${employee.full_name} (#${employee.id}, ${employeeCode}) ==`);

  // ── Wipe this cycle's data for this employee ──
  await prisma.zk_attendance_scans.deleteMany({
    where: { employee_id: employee.id, attendance_date: { gte: d(PERIOD_START), lte: d(PERIOD_END) } },
  });
  await prisma.attendance_staff_daily.deleteMany({
    where: { employee_id: employee.id, date: { gte: d(PERIOD_START), lte: d(PERIOD_END) } },
  });
  await prisma.employee_shift_overrides.deleteMany({
    where: { employee_id: employee.id, date: { gte: d(PERIOD_START), lte: d(PERIOD_END) } },
  });
  await prisma.academic_calendar_days.deleteMany({
    where: { campus_id: CAMPUS_ID, applies_to: 'STAFF', employee_id: employee.id, date: { gte: d(PERIOD_START), lte: d(PERIOD_END) } },
  });
  console.log('  Wiped existing attendance/scan/override/holiday data for this cycle.');

  // ── Device mapping so the payroll UI doesn't show "Not Mapped" ──
  await prisma.device_user_mappings.upsert({
    where: { device_sn_device_pin: { device_sn: device.sn, device_pin: device.pin } },
    create: {
      device_sn: device.sn,
      device_pin: device.pin,
      person_type: 'STAFF',
      employee_id: employee.id,
      display_name: employee.full_name,
      is_active: true,
      notes: '[TEST DATA] seeded for payroll scenario testing',
    },
    update: { employee_id: employee.id, is_active: true },
  });

  // ── Shift overrides (genuinely different shift on that date) ──
  for (const o of overrides) {
    await prisma.employee_shift_overrides.create({
      data: {
        employee_id: employee.id,
        date: d(o.date),
        override_start_time: t(o.date, o.start),
        override_end_time: t(o.date, o.end),
        reason: o.reason,
        created_by: adminId,
      },
    });
  }
  if (overrides.length) console.log(`  Created ${overrides.length} shift override(s).`);

  // ── Day-by-day attendance + scans ──
  let seq = 1;
  for (const day of plan) {
    if (day.kind === 'ABSENT') {
      await prisma.attendance_staff_daily.create({
        data: {
          employee_id: employee.id,
          campus_id: CAMPUS_ID,
          date: d(day.date),
          status: StaffAttendanceStatus.ABSENT,
          source: AttendanceSource.MANUAL,
          marked_by: adminId,
          notes: `[TEST DATA] ${day.note}`,
        },
      });
      continue;
    }

    if (day.kind === 'HOLIDAY') {
      await prisma.academic_calendar_days.create({
        data: {
          campus_id: CAMPUS_ID,
          date: d(day.date),
          day_type: 'HOLIDAY',
          description: `[TEST DATA] ${day.note}`,
          applies_to: 'STAFF',
          employee_id: employee.id,
        },
      });
      continue;
    }

    // SCANS day: figure out the effective expected check-in for this date
    // (an override wins on days it applies) so status is computed exactly
    // the way the real biometric processor would.
    const override = overrides.find((o) => o.date === day.date);
    const expectedCheckIn = override ? t(day.date, override.start) : employee.reporting_time!;
    const graceMinutes = employee.late_relaxation_minutes ?? 0;
    const scans = day.scans!;
    const firstIn = scans[0].time;
    const status = isLate(firstIn, expectedCheckIn, graceMinutes) ? StaffAttendanceStatus.LATE : StaffAttendanceStatus.PRESENT;

    await prisma.zk_attendance_scans.createMany({
      data: scans.map((s) => ({
        device_sn: device.sn,
        device_pin: device.pin,
        person_type: 'STAFF' as const,
        employee_id: employee.id,
        scan_time: s.time,
        attendance_date: d(day.date),
        direction: s.direction,
        sequence_no: seq++,
        is_duplicate: false,
        is_live: false,
      })),
    });

    const lastOut = scans[scans.length - 1].time;
    await prisma.attendance_staff_daily.create({
      data: {
        employee_id: employee.id,
        campus_id: CAMPUS_ID,
        date: d(day.date),
        status,
        source: AttendanceSource.BIOMETRIC,
        check_in_at: firstIn,
        check_out_at: lastOut,
        notes: `[TEST DATA] ${day.note}`,
      },
    });
  }
  console.log(`  Seeded ${plan.length} day(s): ${plan.filter((p) => p.kind === 'SCANS').length} scan day(s), ${plan.filter((p) => p.kind === 'ABSENT').length} absence(s), ${plan.filter((p) => p.kind === 'HOLIDAY').length} holiday(s).`);
}

async function main() {
  const admin = await prisma.users.findFirst({ where: { role: 'SUPER_ADMIN' } });
  if (!admin) throw new Error('No SUPER_ADMIN user found — aborting.');

  await seedEmployee(HASHIR_CODE, HASHIR_PLAN, HASHIR_SHIFT_OVERRIDES, HASHIR_DEVICE, admin.id);
  await seedEmployee(HASSAN_CODE, HASSAN_PLAN, HASSAN_SHIFT_OVERRIDES, HASSAN_DEVICE, admin.id);

  console.log(`\nDone. Generate a TEST payroll run for campus ${CAMPUS_ID}, period ${PERIOD_START} to ${PERIOD_END} (year=2026, month=7) scoped to both employees to see it all.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
