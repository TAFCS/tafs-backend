/**
 * seed-test-payroll-employee.ts
 *
 * Creates (or resets) a clearly-marked TEST employee — MUHAMMAD HASSAN MIRZA,
 * monthly_pay 100000 on campus 1 — and gives them 5 working days of real
 * ZKT-style scan data (check-in, 30-min break, check-out) spread across the
 * current 26 May -> today window, run through the actual
 * ZkAttendanceProcessorService pairing/status logic (not hand-rolled), so the
 * payroll engine can be exercised against a realistic, known-good case.
 *
 * Idempotent: re-running deletes and recreates this employee's scans,
 * attendance, and payroll lines first.
 *
 * Usage: npx ts-node scripts/seed-test-payroll-employee.ts
 */
import { PrismaService } from '../prisma/prisma.service';
import { ZkAttendanceProcessorService } from '../src/modules/attendance/zk-attendance-processor.service';
import { CalendarDayResolverService } from '../src/modules/hr/calendar/calendar-day-resolver.service';
import { AttendancePolicyResolverService } from '../src/modules/attendance/attendance-policy-resolver.service';

const EMPLOYEE_CODE = 'TEST-0001';
const FULL_NAME = 'MUHAMMAD HASSAN MIRZA';
const CAMPUS_ID = 1;

function naiveLocal(y: number, m: number, d: number, hh: number, mm: number): Date {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
}

function attendanceDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

// First 5 weekdays (Mon-Fri) from 26 May 2026 through today.
function pickFiveWorkingDays(): { y: number; m: number; d: number }[] {
  const start = new Date(Date.UTC(2026, 4, 26)); // 26 May 2026
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const days: { y: number; m: number; d: number }[] = [];
  for (let d = new Date(start); d <= end && days.length < 5; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      days.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
    }
  }
  return days;
}

async function main() {
  const prisma = new PrismaService();
  const calendarResolver = new CalendarDayResolverService(prisma);
  const policyResolver = new AttendancePolicyResolverService(prisma);
  // fcmService is never touched by recomputeDaySequence/upsertStaffDaily — safe stub for this seed script.
  const processor = new ZkAttendanceProcessorService(prisma, null as any, calendarResolver, policyResolver, null as any);

  const existing = await prisma.employee_profiles.findFirst({ where: { employee_code: EMPLOYEE_CODE } });
  if (existing) {
    await prisma.payroll_run_lines.deleteMany({ where: { employee_id: existing.id } });
    await prisma.attendance_staff_daily.deleteMany({ where: { employee_id: existing.id } });
    await prisma.zk_attendance_scans.deleteMany({ where: { employee_id: existing.id } });
    await prisma.employee_profiles.delete({ where: { id: existing.id } });
    console.log(`Removed previous TEST employee (id ${existing.id}) and its scan/attendance data.`);
  }

  const employee = await prisma.employee_profiles.create({
    data: {
      employee_code: EMPLOYEE_CODE,
      full_name: FULL_NAME,
      campus_id: CAMPUS_ID,
      monthly_pay: 100000,
      reporting_time: naiveLocal(1970, 1, 1, 8, 0),
      leaving_time: naiveLocal(1970, 1, 1, 14, 0),
      days_per_week: 5,
      job_title: 'Test Employee (Payroll QA)',
      notes: 'Seeded by scripts/seed-test-payroll-employee.ts for payroll engine testing — safe to delete.',
    },
  });
  console.log(`Created employee #${employee.id}: ${FULL_NAME} (${EMPLOYEE_CODE}), monthly_pay 100000, campus ${CAMPUS_ID}.`);

  const workDays = pickFiveWorkingDays();
  console.log('Seeding 5 working days:', workDays.map((w) => `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`));

  for (const { y, m, d } of workDays) {
    const scans = [
      { scan_time: naiveLocal(y, m, d, 8, 0) },  // check-in
      { scan_time: naiveLocal(y, m, d, 12, 0) }, // break-out
      { scan_time: naiveLocal(y, m, d, 12, 30) }, // break-in (30 min break)
      { scan_time: naiveLocal(y, m, d, 14, 0) }, // check-out
    ];
    const attDate = attendanceDate(y, m, d);

    for (const s of scans) {
      await prisma.zk_attendance_scans.create({
        data: {
          device_sn: 'TEST-DEVICE',
          device_pin: 'TEST-HASSAN',
          person_type: 'STAFF',
          employee_id: employee.id,
          scan_time: s.scan_time,
          attendance_date: attDate,
          is_duplicate: false,
          is_live: false,
        },
      });
    }

    const seg = await processor.recomputeDaySequence('STAFF', employee.id, null, attDate);
    await processor.upsertStaffDaily(employee.id, attDate, seg);
  }

  const records = await prisma.attendance_staff_daily.findMany({
    where: { employee_id: employee.id },
    orderBy: { date: 'asc' },
  });
  console.log('\nResulting attendance_staff_daily rows:');
  for (const r of records) {
    console.log(
      ` ${r.date.toISOString().slice(0, 10)}  status=${r.status}  check_in=${r.check_in_at?.toISOString().slice(11, 16)}  check_out=${r.check_out_at?.toISOString().slice(11, 16)}`,
    );
  }

  console.log(`\nDone. Employee id = ${employee.id}. Each seeded day has a 30-minute break (12:00-12:30).`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
