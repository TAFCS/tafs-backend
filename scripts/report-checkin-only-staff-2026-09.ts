/**
 * Staff who routinely punch in and never punch out.
 *
 * Read-only. Writes a CSV, changes nothing.
 *   npx ts-node --transpile-only scripts/report-checkin-only-staff-2026-09.ts
 *
 * "Check-in only" means the day has exactly one non-duplicate scan, that scan is
 * closer to the employee's expected check-in than to their expected check-out,
 * and nothing excuses the day. Every exclusion below exists to keep someone from
 * being disciplined for something that was not their doing.
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarDayResolverService } from '../src/modules/hr/calendar/calendar-day-resolver.service';

const prisma = new PrismaClient();
const calendar = new CalendarDayResolverService(new PrismaService());

/** Devices were not fully live before this — 2–36 people scanned per day until the 13th. */
const FROM = new Date('2026-07-14T00:00:00Z');
/** Today's single scan may simply be someone still at work. */
const TO = new Date('2026-09-24T00:00:00Z');

/**
 * Days when most of the building shows a single scan. That is a device or
 * schedule problem, not 100 people misbehaving: 13 Jul 52%, 29 Aug 67% and
 * 12 Sep 86% of everyone who scanned, against 5–12% on a normal day.
 */
const SYSTEMIC_DAYS = new Set(['2026-07-13', '2026-08-29', '2026-09-12']);

/** Routinely = at least this many days AND at least this share of the days they were present. */
const MIN_DAYS = 5;
const MIN_SHARE = 0.15;

const dstr = (d: Date) => d.toISOString().slice(0, 10);
const minutes = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
const csv = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(async () => {
  const scans = await prisma.zk_attendance_scans.findMany({
    where: { person_type: 'STAFF', employee_id: { not: null }, is_duplicate: false, attendance_date: { gte: FROM, lte: TO } },
    select: { employee_id: true, attendance_date: true, scan_time: true },
    orderBy: { scan_time: 'asc' },
  });
  const byDay = new Map<string, { emp: number; date: Date; times: Date[] }>();
  for (const s of scans) {
    const k = `${s.employee_id}|${dstr(s.attendance_date)}`;
    const e = byDay.get(k) ?? { emp: s.employee_id!, date: s.attendance_date, times: [] };
    e.times.push(s.scan_time);
    byDay.set(k, e);
  }

  const employees = await prisma.employee_profiles.findMany({
    select: {
      id: true, employee_code: true, full_name: true, employment_status: true, campus_id: true,
      campuses: { select: { campus_name: true } },
      segments: { select: { name: true } },
      departments: { select: { name: true } },
      staff_categories: { select: { name: true } },
    },
  });
  const emp = new Map(employees.map((e) => [e.id, e]));

  const daily = await prisma.attendance_staff_daily.findMany({
    where: { date: { gte: FROM, lte: TO } },
    select: { employee_id: true, date: true, status: true, source: true, expected_check_in_snapshot: true, expected_check_out_snapshot: true },
  });
  const dailyBy = new Map(daily.map((d) => [`${d.employee_id}|${dstr(d.date)}`, d]));

  /**
   * Working-day check for the single-scan days only, run in parallel: each call
   * is several remote reads, and doing ~700 of them one after another takes
   * over ten minutes.
   */
  calendar.beginBatch();
  const workingDay = new Map<string, boolean>();
  {
    const todo = [...byDay.values()].filter((d) => {
      const e = emp.get(d.emp);
      return d.times.length === 1 && e?.employment_status === 'ACTIVE' && e.campus_id != null && !SYSTEMIC_DAYS.has(dstr(d.date));
    });
    let next = 0, done = 0;
    const worker = async () => {
      while (next < todo.length) {
        const d = todo[next++];
        const cal = await calendar.resolveStaffDay(d.emp, emp.get(d.emp)!.campus_id!, d.date);
        workingDay.set(`${d.emp}|${dstr(d.date)}`, cal.isWorkingDay);
        if (++done % 100 === 0) console.log(`  calendar ${done}/${todo.length}`);
      }
    };
    await Promise.all(Array.from({ length: 10 }, worker));
  }
  type Stat = { present: number; only: number; morning: number; afternoon: number; manual: number; late: number; recent: number; recentPresent: number; last: string; sample: string[] };
  const stats = new Map<number, Stat>();
  const dropped = { systemic: 0, nonWorking: 0, excused: 0, inactive: 0 };
  const cutRecent = new Date(TO.getTime() - 27 * 86400000);

  for (const day of byDay.values()) {
    const e = emp.get(day.emp);
    if (!e) continue;
    const date = dstr(day.date);
    if (SYSTEMIC_DAYS.has(date)) { dropped.systemic++; continue; }
    if (e.employment_status !== 'ACTIVE') { dropped.inactive++; continue; }
    const d = dailyBy.get(`${e.id}|${date}`);
    if (d?.status === 'EXCUSED') { dropped.excused++; continue; }
    // The calendar is only consulted for single-scan days. It costs several
    // remote reads per call, and a day with two scans counts as a normal day
    // worked whatever the calendar says. That errs toward the employee: a
    // non-working day with two scans can only lower their share.
    if (day.times.length === 1 && workingDay.get(`${e.id}|${date}`) === false) { dropped.nonWorking++; continue; }

    const s = stats.get(e.id) ?? { present: 0, only: 0, morning: 0, afternoon: 0, manual: 0, late: 0, recent: 0, recentPresent: 0, last: '', sample: [] };
    s.present++;
    if (day.date >= cutRecent) s.recentPresent++;
    if (day.times.length === 1) {
      const t = minutes(day.times[0]);
      // Which end of the day is this scan closer to? Fall back to noon when no expected times are on record.
      const inAt = d?.expected_check_in_snapshot ? minutes(d.expected_check_in_snapshot) : null;
      const outAt = d?.expected_check_out_snapshot ? minutes(d.expected_check_out_snapshot) : null;
      const nearIn = inAt != null && outAt != null ? Math.abs(t - inAt) <= Math.abs(t - outAt) : t < 12 * 60;
      if (nearIn) {
        s.only++;
        if (d?.source === 'MANUAL') s.manual++;
        if (d?.status === 'LATE') s.late++;
        if (day.date >= cutRecent) s.recent++;
        s.last = date;
        if (s.sample.length < 6) s.sample.push(`${date.slice(5)} ${day.times[0].toISOString().slice(11, 16)}`);
      } else {
        s.afternoon++;
      }
    }
    stats.set(e.id, s);
  }
  calendar.endBatch();

  const all = [...stats.entries()].filter(([, s]) => s.only > 0);
  const flagged = all.filter(([, s]) => s.only >= MIN_DAYS && s.only / s.present >= MIN_SHARE);

  console.log(`window ${dstr(FROM)} → ${dstr(TO)}   dropped person-days: systemic ${dropped.systemic}, non-working ${dropped.nonWorking}, excused ${dropped.excused}, not active ${dropped.inactive}`);
  console.log(`active staff with any check-in-only day: ${all.length}   flagged (>=${MIN_DAYS} days and >=${MIN_SHARE * 100}%): ${flagged.length}`);
  const bucket = new Map<number, number>();
  all.forEach(([, s]) => bucket.set(Math.min(s.only, 15), (bucket.get(Math.min(s.only, 15)) ?? 0) + 1));
  console.log('people by number of check-in-only days:');
  [...bucket].sort((a, b) => a[0] - b[0]).forEach(([n, c]) => console.log(`  ${n === 15 ? '15+' : String(n).padStart(3)} day(s): ${c}`));

  const rows = flagged
    .map(([id, s]) => ({ e: emp.get(id)!, s }))
    .sort((a, b) => b.s.only - a.s.only || b.s.only / b.s.present - a.s.only / a.s.present);

  const header = ['Employee Code', 'Employee Name', 'Campus', 'Segment', 'Department', 'Staff Category', 'Days Present', 'Check-in Only Days', '% of Days Present', 'Days HR Fixed Manually', 'Days Marked Late', 'Check-in Only Days (last 4 weeks)', 'Days Present (last 4 weeks)', 'Most Recent', 'Sample Days (date time)', 'Afternoon-only Days (missed check-in, not counted)'];
  const lines = [header.join(',')];
  for (const { e, s } of rows) {
    lines.push([
      e.employee_code, e.full_name, e.campuses?.campus_name ?? '', e.segments?.name ?? '', e.departments?.name ?? '', e.staff_categories?.name ?? '',
      s.present, s.only, ((s.only / s.present) * 100).toFixed(0) + '%', s.manual, s.late, s.recent, s.recentPresent, s.last, s.sample.join('; '), s.afternoon,
    ].map(csv).join(','));
  }
  const out = '/Users/aawaizali/Desktop/staff-checkin-without-checkout-2026-07-14_to_09-24.csv';
  fs.writeFileSync(out, '﻿' + lines.join('\n') + '\n');
  console.log(`\nwrote ${rows.length} rows → ${out}`);

  const by = (f: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, number>(); rows.forEach((r) => m.set(f(r) || '(none)', (m.get(f(r) || '(none)') ?? 0) + 1));
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ');
  };
  console.log('by campus :', by((r) => r.e.campuses?.campus_name ?? ''));
  console.log('by segment:', by((r) => r.e.segments?.name ?? ''));
  console.log('\ntop 12:');
  rows.slice(0, 12).forEach(({ e, s }) => console.log(`  ${String(e.employee_code).padEnd(15)} ${e.full_name.slice(0, 26).padEnd(27)} ${s.only}/${s.present} days (${((s.only / s.present) * 100).toFixed(0)}%)  recent ${s.recent}/${s.recentPresent}  hr-fixed ${s.manual}`));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAILED:', e); await prisma.$disconnect(); process.exit(1); });
