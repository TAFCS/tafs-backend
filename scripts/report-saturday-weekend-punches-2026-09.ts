/**
 * 5-day staff who keep punching in on Saturdays.
 *
 * Read-only: writes a workbook, changes nothing.
 *   npx ts-node --transpile-only scripts/report-saturday-weekend-punches-2026-09.ts
 *
 * "Weekend Saturday" is decided by the system's own day resolver, per employee
 * (CalendarDayResolverService.resolveStaffDay), so this lists exactly the
 * Saturdays the processor stamped EXCUSED - Weekend. That resolver already
 * honours a timetable, an explicit work schedule, days_per_week (unset = 5), a
 * calendar workday, and an assigned Mandatory Saturday - so teachers rostered
 * for a Saturday are not listed.
 */
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarDayResolverService } from '../src/modules/hr/calendar/calendar-day-resolver.service';

const prisma = new PrismaClient();
const calendar = new CalendarDayResolverService(new PrismaService());

/** Same window as the check-out report: devices were not fully live before the 14th. */
const FROM = new Date('2026-07-14T00:00:00Z');
const TO = new Date('2026-09-24T00:00:00Z');
/** Regularly = on at least this many Saturdays in the window, NOT counting mass days. */
const REGULAR_MIN = 3;
/**
 * A "mass day" is a Saturday on which this many staff were all weekend-called at
 * once. That is a school event nobody put in the calendar (1 Aug: 67 of 103
 * scanners, no teacher rostered), not 67 individuals misbehaving, so it cannot
 * count toward "regularly". The next busiest Saturday had 30, so the gap is wide.
 */
const MASS_DAY_MIN = 35;
const OUT = '/Volumes/sticky/aawaizali-migration/Desktop/TAFS/staff-saturday-punches-on-weekend-2026-07-14_to_09-24.xlsx';

const d10 = (x: Date) => x.toISOString().slice(0, 10);
const hhmm = (x: Date) => x.toISOString().slice(11, 16);
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

(async () => {
  const saturdays: string[] = [];
  for (let t = new Date(FROM); t <= TO; t = new Date(t.getTime() + 86400000)) if (t.getUTCDay() === 6) saturdays.push(d10(t));

  const scans = await prisma.zk_attendance_scans.findMany({
    where: { person_type: 'STAFF', employee_id: { not: null }, is_duplicate: false, attendance_date: { gte: FROM, lte: TO } },
    select: { employee_id: true, attendance_date: true, scan_time: true },
    orderBy: { scan_time: 'asc' },
  });
  const sat = new Map<string, { emp: number; date: Date; times: string[] }>();
  for (const s of scans) {
    if (s.attendance_date.getUTCDay() !== 6) continue;
    const k = `${s.employee_id}|${d10(s.attendance_date)}`;
    const e = sat.get(k) ?? { emp: s.employee_id!, date: s.attendance_date, times: [] };
    e.times.push(hhmm(s.scan_time));
    sat.set(k, e);
  }

  const employees = await prisma.employee_profiles.findMany({
    select: {
      id: true, employee_code: true, full_name: true, employment_status: true, days_per_week: true, check_in_source: true, campus_id: true,
      campuses: { select: { campus_name: true } }, segments: { select: { name: true } },
      departments: { select: { name: true } }, staff_categories: { select: { name: true } },
      _count: { select: { employee_work_schedules: true } },
    },
  });
  const emp = new Map(employees.map((e) => [e.id, e]));
  const pins = new Map<number, string[]>();
  for (const m of await prisma.device_user_mappings.findMany({ where: { person_type: 'STAFF', is_active: true, employee_id: { not: null } }, select: { employee_id: true, device_pin: true } })) {
    pins.set(m.employee_id!, [...new Set([...(pins.get(m.employee_id!) ?? []), m.device_pin])]);
  }
  const daily = new Map((await prisma.attendance_staff_daily.findMany({
    where: { date: { gte: FROM, lte: TO } }, select: { employee_id: true, date: true, status: true, source: true },
  })).map((d) => [`${d.employee_id}|${d10(d.date)}`, d]));

  // Ask the system whether each Saturday was a working day for that person. Parallel: each call is several remote reads.
  calendar.beginBatch();
  const todo = [...sat.values()].filter((v) => emp.get(v.emp)?.campus_id != null);
  const weekend: { emp: number; date: string; times: string[]; called: string; row: string }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (next < todo.length) {
      const v = todo[next++];
      const r = await calendar.resolveStaffDay(v.emp, emp.get(v.emp)!.campus_id!, v.date);
      if (r.isWorkingDay) continue;
      const dl = daily.get(`${v.emp}|${d10(v.date)}`);
      weekend.push({
        emp: v.emp, date: d10(v.date), times: v.times,
        called: r.description ?? r.dayType ?? 'Day off',
        row: dl ? `${dl.status} (${dl.source})` : 'No daily record',
      });
    }
  }));
  calendar.endBatch();

  const rosterBy = new Map((await prisma.teacher_saturday_schedules.groupBy({ by: ['date'], _count: { _all: true } })).map((r) => [d10(r.date), r._count._all]));
  const scannedBy = new Map<string, number>();
  for (const v of sat.values()) scannedBy.set(d10(v.date), (scannedBy.get(d10(v.date)) ?? 0) + 1);
  const weekendBy = new Map<string, number>();
  for (const w of weekend) weekendBy.set(w.date, (weekendBy.get(w.date) ?? 0) + 1);
  const massDays = new Set(saturdays.filter((d) => (weekendBy.get(d) ?? 0) >= MASS_DAY_MIN));

  const markedAs = (e: NonNullable<ReturnType<typeof emp.get>>) => {
    if (e.check_in_source === 'TIMETABLE') return 'Timetable-based (no Saturday slot)';
    if (e._count.employee_work_schedules > 0) return 'Custom work schedule';
    if (e.days_per_week == null) return '5-day (default - days/week not set)';
    return `${e.days_per_week}-day`;
  };

  const byEmp = new Map<number, typeof weekend>();
  for (const w of weekend) byEmp.set(w.emp, [...(byEmp.get(w.emp) ?? []), w]);

  const people = [...byEmp.entries()]
    .map(([id, days]) => ({ e: emp.get(id)!, days: days.sort((a, b) => a.date.localeCompare(b.date)) }))
    .filter((p) => p.e.employment_status === 'ACTIVE');
  const leftExcluded = byEmp.size - people.length;

  const row = ({ e, days }: (typeof people)[number]) => {
    const firsts = days.map((d) => mins(d.times[0]));
    const lasts = days.map((d) => mins(d.times[d.times.length - 1]));
    const stillExcused = days.filter((d) => d.row.startsWith('EXCUSED')).length;
    const noRecord = days.filter((d) => d.row === 'No daily record').length;
    return {
      name: e.full_name, code: e.employee_code ?? '', pin: (pins.get(e.id) ?? []).join(' / '),
      campus: e.campuses?.campus_name ?? '', segment: e.segments?.name ?? '(none assigned)',
      dept: e.departments?.name ?? '', cat: e.staff_categories?.name ?? '', marked: markedAs(e),
      n: days.length, nExcl: days.filter((d) => !massDays.has(d.date)).length, of: saturdays.length,
      dates: days.map((d) => d.date.slice(5) + (massDays.has(d.date) ? '*' : '')).join(', '),
      stillExcused, noRecord, single: days.filter((d) => d.times.length === 1).length,
      typIn: clock(median(firsts)), typOut: days.some((d) => d.times.length > 1) ? clock(median(lasts.filter((_, i) => days[i].times.length > 1))) : '',
    };
  };
  const sortDesc = (a: ReturnType<typeof row>, b: ReturnType<typeof row>) => b.nExcl - a.nExcl || b.n - a.n || a.name.localeCompare(b.name);
  const all = people.map(row);
  const regular = all.filter((r) => r.nExcl >= REGULAR_MIN).sort(sortDesc);
  const occasional = all.filter((r) => r.nExcl < REGULAR_MIN).sort(sortDesc);

  // ── workbook ──
  const wb = new ExcelJS.Workbook();
  const HEAD = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } } as const;
  const styleSheet = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).eachCell((c) => { c.font = HEAD; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } }; c.alignment = { vertical: 'middle', wrapText: true }; });
    ws.getRow(1).height = 32;
    ws.eachRow((r, i) => { if (i > 1) r.eachCell((c) => { c.font = { name: 'Arial', size: 10 }; c.alignment = { vertical: 'top', wrapText: true }; }); });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  };
  const peopleCols = [
    { header: 'Employee', key: 'name', width: 26 }, { header: 'Code', key: 'code', width: 16 }, { header: 'PIN', key: 'pin', width: 12 },
    { header: 'Campus', key: 'campus', width: 22 }, { header: 'Segment', key: 'segment', width: 20 }, { header: 'Department', key: 'dept', width: 20 },
    { header: 'Staff Category', key: 'cat', width: 20 }, { header: 'Marked As', key: 'marked', width: 30 },
    { header: `Saturdays Punched (of ${saturdays.length})`, key: 'n', width: 13 },
    { header: 'Excluding Mass Days', key: 'nExcl', width: 12 }, { header: 'Dates (MM-DD, * = mass day)', key: 'dates', width: 44 },
    { header: 'Still EXCUSED (system row)', key: 'stillExcused', width: 14 }, { header: 'No Daily Record', key: 'noRecord', width: 12 },
    { header: 'Days With Only One Punch', key: 'single', width: 13 }, { header: 'Typical Arrival', key: 'typIn', width: 11 }, { header: 'Typical Departure', key: 'typOut', width: 11 },
  ];
  for (const [title, data] of [[`Regular (${REGULAR_MIN}+ Saturdays)`, regular], ['Occasional (under 3)', occasional]] as const) {
    const ws = wb.addWorksheet(title); ws.columns = peopleCols; data.forEach((r) => ws.addRow(r)); styleSheet(ws);
  }
  const det = wb.addWorksheet('Every Saturday Punch');
  det.columns = [
    { header: 'Employee', key: 'name', width: 26 }, { header: 'Code', key: 'code', width: 16 }, { header: 'PIN', key: 'pin', width: 12 },
    { header: 'Campus', key: 'campus', width: 22 }, { header: 'Saturday', key: 'date', width: 12 }, { header: 'First Punch', key: 'first', width: 11 },
    { header: 'Last Punch', key: 'last', width: 11 }, { header: 'Punches', key: 'count', width: 9 }, { header: 'System Called It', key: 'called', width: 22 },
    { header: 'Daily Row Now', key: 'row', width: 24 },
    { header: 'Staff Weekend-Called That Day', key: 'wk', width: 14 }, { header: 'Teachers Rostered That Day', key: 'ros', width: 14 },
    { header: 'Mass Day?', key: 'mass', width: 10 },
  ];
  for (const p of [...people].sort((a, b) => b.days.filter((d) => !massDays.has(d.date)).length - a.days.filter((d) => !massDays.has(d.date)).length || b.days.length - a.days.length || a.e.full_name.localeCompare(b.e.full_name))) {
    for (const d of p.days) det.addRow({ name: p.e.full_name, code: p.e.employee_code ?? '', pin: (pins.get(p.e.id) ?? []).join(' / '), campus: p.e.campuses?.campus_name ?? '', date: d.date, first: d.times[0], last: d.times[d.times.length - 1], count: d.times.length, called: d.called, row: d.row, wk: weekendBy.get(d.date) ?? 0, ros: rosterBy.get(d.date) ?? 0, mass: massDays.has(d.date) ? 'YES' : '' });
  }
  styleSheet(det);

  const notes = wb.addWorksheet('Read Me');
  notes.columns = [{ width: 110 }];
  [
    `Staff who punched in on a Saturday the system treats as a weekend day off - ${d10(FROM)} to ${d10(TO)} (${saturdays.length} Saturdays).`,
    '',
    'HOW A SATURDAY IS JUDGED: per employee, by the same day resolver payroll and attendance use. A Saturday is a weekend day when the employee is on a 5-day week (days/week 5, or not set - the system defaults to 5), has no explicit work schedule, has no timetable slot, the calendar does not declare it a workday, and they are not rostered for a Mandatory Saturday.',
    'So teachers assigned a Mandatory Saturday, and anyone the calendar says is working, are NOT listed.',
    '',
    `REGULAR = on at least ${REGULAR_MIN} Saturdays, NOT counting mass days. Occasional = fewer than that.`,
    `MASS DAYS (marked *): Saturdays on which ${MASS_DAY_MIN}+ staff were weekend-called at once - ${[...massDays].join(', ') || 'none'}. That is a school event missing from the calendar, not individual behaviour, so those days do not count toward "regularly". They are still listed in the detail tab.`,
    'ROSTER GAPS: on school Saturdays (Teachers Rostered in the detail tab is 20+), a teacher who came but was not on the Mandatory Saturday roster shows up here. That is a roster gap to fix, not necessarily a conduct problem.',
    'Still EXCUSED = the daily attendance row was set to EXCUSED by the system and the processor never overwrites system rows, so the punch is stored but the day is not counted as worked.',
    'No Daily Record = no attendance row exists for that day at all.',
    'Days With Only One Punch = checked in and never out on that Saturday, so no worked hours can be derived.',
    'Typical Arrival / Departure = the median first and last punch (departure only from days with two or more punches).',
    '',
    `EXCLUDED: ${leftExcluded} people who have since left (employment status LEFT).`,
    'PIN = the active biometric device PIN. Marked As "5-day (default - days/week not set)" means nobody has set days/week on the profile, so the system assumes 5.',
    '',
    'PAYROLL: a day the calendar calls a day off is classified DAY_OFF unless HR records a manual override on that date - a manual record always wins. Nothing here has been changed.',
    '',
    'SATURDAY-BY-SATURDAY:  date | staff who scanned | weekend-called | teachers rostered',
    ...saturdays.map((d) => `  ${d}${massDays.has(d) ? '  *MASS DAY*' : ''}  |  ${scannedBy.get(d) ?? 0}  |  ${weekendBy.get(d) ?? 0}  |  ${rosterBy.get(d) ?? 0}`),
  ].forEach((t) => notes.addRow([t]).getCell(1).alignment = { wrapText: true, vertical: 'top' });
  notes.getRow(1).font = { name: 'Arial', bold: true, size: 12 };
  notes.eachRow((r, i) => { if (i > 1) r.getCell(1).font = { name: 'Arial', size: 10 }; });
  wb.worksheets.unshift(wb.worksheets.splice(wb.worksheets.indexOf(notes), 1)[0]);

  await wb.xlsx.writeFile(OUT);
  console.log(`weekend-Saturday punches: ${weekend.length} across ${byEmp.size} people (${leftExcluded} left, excluded) -> ${people.length} active`);
  console.log(`mass days: ${[...massDays].join(', ')}`);
  console.log(`regular (${REGULAR_MIN}+ excl. mass days): ${regular.length}   occasional: ${occasional.length}   detail rows: ${det.rowCount - 1}`);
  console.log(`wrote ${OUT}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAILED:', e); await prisma.$disconnect(); process.exit(1); });
