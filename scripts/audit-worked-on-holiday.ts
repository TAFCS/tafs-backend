/**
 * Read-only audit: employees who had a HOLIDAY marked for them on a date, yet
 * still physically showed up (a biometric / gate-desk scan lands in
 * `zk_attendance_scans` for them that day).
 *
 * A holiday is only counted when an `academic_calendar_days` row with
 * `applies_to = 'STAFF'` and `day_type = 'HOLIDAY'` is the *best* (most specific)
 * calendar match for that employee on that date — mirroring
 * CalendarDayResolverService.resolveStaffDay(). If a more specific row is a
 * WORKDAY override, the day is NOT a holiday and is skipped.
 *
 * Weekends / scheduled days-off with no explicit calendar HOLIDAY row are
 * reported separately (they are "days off", not "holidays marked").
 *
 * Writes nothing. Emits CSVs next to the repo root.
 *
 * Usage: npx ts-node scripts/audit-worked-on-holiday.ts
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();
const OUT_DIR = join(__dirname, '../..');
const MANUAL_DEVICE_SN = 'MANUAL';

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(name: string, rows: Record<string, unknown>[]): string {
  const path = join(OUT_DIR, name);
  if (rows.length === 0) {
    writeFileSync(path, '');
    return path;
  }
  const header = Object.keys(rows[0]);
  const body = rows.map((r) => header.map((h) => csvEscape(r[h])).join(','));
  writeFileSync(path, [header.join(','), ...body].join('\n') + '\n');
  return path;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

type CalRow = {
  date: Date;
  campus_id: number;
  day_type: string;
  description: string | null;
  department_id: number | null;
  staff_category_id: number | null;
  employee_id: number | null;
};

// ── mirrors CalendarDayResolverService, STAFF audience only ──────────────────
function staffSpecificity(r: CalRow): number {
  if (r.employee_id) return 5;
  if (r.department_id && r.staff_category_id) return 4;
  if (r.department_id) return 3;
  if (r.staff_category_id) return 2;
  return 1;
}

function matchesStaffScope(
  r: CalRow,
  employeeId: number,
  departmentId: number | null,
  staffCategoryId: number | null,
): boolean {
  if (r.employee_id != null) return r.employee_id === employeeId;
  if (r.department_id != null && r.staff_category_id != null) {
    return r.department_id === departmentId && r.staff_category_id === staffCategoryId;
  }
  if (r.department_id != null) return r.department_id === departmentId;
  if (r.staff_category_id != null) return r.staff_category_id === staffCategoryId;
  return r.employee_id == null && r.department_id == null && r.staff_category_id == null;
}

function pickBest(rows: CalRow[]): CalRow | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, row) => (staffSpecificity(row) > staffSpecificity(best) ? row : best));
}

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

async function main() {
  // 1. All STAFF calendar rows (HOLIDAY + WORKDAY overrides both needed).
  const calRows = (await prisma.academic_calendar_days.findMany({
    where: { applies_to: 'STAFF' },
    select: {
      date: true,
      campus_id: true,
      day_type: true,
      description: true,
      department_id: true,
      staff_category_id: true,
      employee_id: true,
    },
  })) as CalRow[];

  // index: campus_id -> 'YYYY-MM-DD' -> CalRow[]
  const calByCampusDate = new Map<string, CalRow[]>();
  for (const r of calRows) {
    const key = `${r.campus_id}|${iso(r.date)}`;
    const b = calByCampusDate.get(key);
    if (b) b.push(r);
    else calByCampusDate.set(key, [r]);
  }
  const holidayDatesByCampus = new Map<number, Set<string>>();
  for (const r of calRows) {
    if (r.day_type !== 'HOLIDAY') continue;
    let s = holidayDatesByCampus.get(r.campus_id);
    if (!s) holidayDatesByCampus.set(r.campus_id, (s = new Set()));
    s.add(iso(r.date));
  }

  // 2. Employees.
  const employees = await prisma.employee_profiles.findMany({
    select: {
      id: true,
      full_name: true,
      employee_code: true,
      campus_id: true,
      department_id: true,
      staff_category_id: true,
      employment_status: true,
      campuses: { select: { campus_name: true } },
      departments: { select: { name: true } },
      staff_categories: { select: { name: true } },
    },
  });
  const empById = new Map(employees.map((e) => [e.id, e]));

  // 3. Employee-attributed scans, one row per (employee, date).
  const scanDays = await prisma.$queryRaw<
    {
      employee_id: number;
      attendance_date: Date;
      scans: bigint;
      real_scans: bigint;
      manual_scans: bigint;
      first_scan: Date;
      last_scan: Date;
      devices: string;
    }[]
  >`
    SELECT s.employee_id,
           s.attendance_date,
           COUNT(*)                                             AS scans,
           COUNT(*) FILTER (WHERE s.device_sn <> ${MANUAL_DEVICE_SN}) AS real_scans,
           COUNT(*) FILTER (WHERE s.device_sn =  ${MANUAL_DEVICE_SN}) AS manual_scans,
           MIN(s.scan_time)                                     AS first_scan,
           MAX(s.scan_time)                                     AS last_scan,
           STRING_AGG(DISTINCT s.device_sn, '|' ORDER BY s.device_sn) AS devices
    FROM zk_attendance_scans s
    WHERE s.employee_id IS NOT NULL
      AND s.is_duplicate = false
    GROUP BY s.employee_id, s.attendance_date
  `;

  const holidayEvents: Record<string, unknown>[] = [];
  const dayOffEvents: Record<string, unknown>[] = [];

  for (const sd of scanDays) {
    const emp = empById.get(sd.employee_id);
    if (!emp || emp.campus_id == null) continue;
    const dateKey = iso(sd.attendance_date);

    // resolve the best STAFF calendar row for this employee on this date
    const dayRows = calByCampusDate.get(`${emp.campus_id}|${dateKey}`) ?? [];
    const matching = dayRows.filter((r) =>
      matchesStaffScope(r, emp.id, emp.department_id, emp.staff_category_id),
    );
    const best = pickBest(matching);

    const base = {
      employee_id: emp.id,
      employee_code: emp.employee_code ?? '',
      full_name: emp.full_name ?? '',
      employment_status: emp.employment_status,
      campus: emp.campuses?.campus_name ?? emp.campus_id,
      department: emp.departments?.name ?? '',
      staff_category: emp.staff_categories?.name ?? '',
      date: dateKey,
      weekday: sd.attendance_date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
      scans: Number(sd.scans),
      real_device_scans: Number(sd.real_scans),
      manual_gate_scans: Number(sd.manual_scans),
      first_scan: sd.first_scan?.toISOString().replace('T', ' ').slice(0, 19),
      last_scan: sd.last_scan?.toISOString().replace('T', ' ').slice(0, 19),
      devices: sd.devices,
    };

    if (best && best.day_type === 'HOLIDAY') {
      holidayEvents.push({
        ...base,
        holiday_description: best.description?.replace('[PINNED] ', '') ?? '',
        holiday_scope: best.employee_id
          ? 'EMPLOYEE'
          : best.department_id && best.staff_category_id
            ? 'DEPT+CATEGORY'
            : best.department_id
              ? 'DEPARTMENT'
              : best.staff_category_id
                ? 'STAFF_CATEGORY'
                : 'WHOLE_CAMPUS',
      });
    } else if (!best && isWeekend(sd.attendance_date)) {
      // no explicit calendar row and it's Sat/Sun — a day off, not a "holiday marked"
      dayOffEvents.push({ ...base, reason: 'WEEKEND (no explicit calendar row)' });
    }
  }

  holidayEvents.sort(
    (a, b) =>
      String(a.full_name).localeCompare(String(b.full_name)) ||
      String(a.date).localeCompare(String(b.date)),
  );
  dayOffEvents.sort(
    (a, b) =>
      String(a.full_name).localeCompare(String(b.full_name)) ||
      String(a.date).localeCompare(String(b.date)),
  );

  // per-employee rollup (holiday events only)
  const perEmp = new Map<
    number,
    { emp: (typeof employees)[number]; dates: Set<string>; scans: number; realScans: number }
  >();
  for (const ev of holidayEvents) {
    const id = ev.employee_id as number;
    let x = perEmp.get(id);
    if (!x) perEmp.set(id, (x = { emp: empById.get(id)!, dates: new Set(), scans: 0, realScans: 0 }));
    x.dates.add(ev.date as string);
    x.scans += ev.scans as number;
    x.realScans += ev.real_device_scans as number;
  }
  const perEmpRows = [...perEmp.values()]
    .map((x) => ({
      employee_id: x.emp.id,
      employee_code: x.emp.employee_code ?? '',
      full_name: x.emp.full_name ?? '',
      employment_status: x.emp.employment_status,
      campus: x.emp.campuses?.campus_name ?? x.emp.campus_id,
      department: x.emp.departments?.name ?? '',
      staff_category: x.emp.staff_categories?.name ?? '',
      holiday_days_worked: x.dates.size,
      total_scans_on_those_days: x.scans,
      real_device_scans_on_those_days: x.realScans,
    }))
    .sort((a, b) => b.holiday_days_worked - a.holiday_days_worked);

  const p1 = writeCsv('worked-on-holiday-per-employee.csv', perEmpRows);
  const p2 = writeCsv('worked-on-holiday-detail.csv', holidayEvents);
  const p3 = writeCsv('worked-on-dayoff-weekend-detail.csv', dayOffEvents);

  const totalHolidayEvents = holidayEvents.length; // == distinct (employee, holiday-date) pairs
  const employeesAffected = perEmp.size;

  console.log('══════════════════════════════════════════════════════════════');
  console.log(' WORKED ON A MARKED HOLIDAY — SUMMARY');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`STAFF calendar HOLIDAY rows loaded : ${calRows.filter((r) => r.day_type === 'HOLIDAY').length}`);
  console.log(`(employee, holiday-date) scan pairs: ${totalHolidayEvents}`);
  console.log(`distinct employees affected        : ${employeesAffected}`);
  console.log(
    `total scans across those days      : ${holidayEvents.reduce((s, e) => s + (e.scans as number), 0)} ` +
      `(${holidayEvents.reduce((s, e) => s + (e.real_device_scans as number), 0)} on real biometric devices)`,
  );
  console.log('');
  console.log('Top offenders:');
  for (const r of perEmpRows.slice(0, 25)) {
    console.log(
      `  ${String(r.holiday_days_worked).padStart(3)} day(s)  ` +
        `${(r.full_name || '(no name)').padEnd(32)} ${String(r.employee_code).padEnd(12)} ${r.campus}`,
    );
  }
  console.log('');
  console.log(`Separately — scanned on a WEEKEND with no calendar row: ${dayOffEvents.length} (employee, date) pairs`);
  console.log('');
  console.log('CSVs written:');
  console.log('  ' + p1);
  console.log('  ' + p2);
  console.log('  ' + p3);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
