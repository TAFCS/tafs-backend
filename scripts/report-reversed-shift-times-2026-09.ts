/**
 * Employees whose expected check-in (reporting_time) is not before their
 * expected check-out (leaving_time).
 *
 * Read-only: writes a CSV, changes nothing.
 *   npx ts-node --transpile-only scripts/report-reversed-shift-times-2026-09.ts
 *
 * A reversed pair is nearly always a 12-hour slip (19:30 typed for 07:30), so
 * the CSV also shows when the person actually punches in and out, which usually
 * settles what the right value is.
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

const prisma = new PrismaClient();
const OUT = '/Volumes/sticky/aawaizali-migration/Desktop/TAFS/employees-reporting-time-after-leaving-time.csv';
const FROM = new Date('2026-07-14T00:00:00Z');
const TO = new Date('2026-09-24T00:00:00Z');

const mins = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const csv = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

(async () => {
  const emps = await prisma.employee_profiles.findMany({
    where: { reporting_time: { not: null }, leaving_time: { not: null } },
    select: {
      id: true, employee_code: true, full_name: true, employment_status: true, check_in_source: true, job_title: true, reporting_time: true, leaving_time: true,
      campuses: { select: { campus_name: true } }, segments: { select: { name: true } },
      departments: { select: { name: true } }, staff_categories: { select: { name: true } },
    },
  });
  const bad = emps.filter((e) => mins(e.reporting_time!) >= mins(e.leaving_time!));

  const rows: string[] = [];
  const header = ['Employee Code', 'Employee Name', 'Status', 'Campus', 'Segment', 'Department', 'Staff Category', 'Job Title', 'Times Source', 'Expected Check-in (saved)', 'Expected Check-out (saved)', 'Problem', 'Typical Actual Arrival', 'Typical Actual Departure', 'Days Punched', 'Likely Correction'];
  rows.push(header.join(','));

  for (const e of bad.sort((a, b) => String(a.employee_code).localeCompare(String(b.employee_code)))) {
    const scans = await prisma.zk_attendance_scans.findMany({
      where: { person_type: 'STAFF', employee_id: e.id, is_duplicate: false, attendance_date: { gte: FROM, lte: TO } },
      select: { attendance_date: true, scan_time: true }, orderBy: { scan_time: 'asc' },
    });
    const days = new Map<string, number[]>();
    for (const s of scans) { const k = s.attendance_date.toISOString().slice(0, 10); days.set(k, [...(days.get(k) ?? []), mins(s.scan_time)]); }
    const firsts = [...days.values()].map((t) => t[0]);
    const lasts = [...days.values()].filter((t) => t.length > 1).map((t) => t[t.length - 1]);

    const rep = mins(e.reporting_time!), lea = mins(e.leaving_time!);
    const problem = rep === lea ? 'Check-in equals check-out' : `Check-in is ${((rep - lea) / 60).toFixed(1)}h after check-out`;

    // A 12-hour slip: check-in typed as PM, or check-out typed as AM. Say which fix makes the pair valid.
    let fix = 'Cannot tell - confirm the shift with HR';
    if (rep >= 12 * 60 && rep - 720 < lea) fix = `Check-in likely ${clock(rep - 720)} (PM typed for AM)`;
    else if (lea < 12 * 60 && lea + 720 > rep) fix = `Check-out likely ${clock(lea + 720)} (AM typed for PM)`;
    // The punches confirm the fix when the person punches out; with none on record it is only a guess.
    if (!lasts.length && fix.startsWith('Check')) fix += ' - UNCONFIRMED, no punch-outs on record';

    rows.push([
      e.employee_code, e.full_name, e.employment_status, e.campuses?.campus_name ?? '', e.segments?.name ?? '(none assigned)', e.departments?.name ?? '', e.staff_categories?.name ?? '', e.job_title ?? '',
      e.check_in_source, clock(rep), clock(lea), problem,
      firsts.length ? clock(median(firsts)) : 'no punches', lasts.length ? clock(median(lasts)) : 'no punch-outs', days.size, fix,
    ].map(csv).join(','));
  }
  fs.writeFileSync(OUT, '﻿' + rows.join('\n') + '\n');
  console.log(`checked ${emps.length} employees with both times set; reversed or equal: ${bad.length}`);
  console.log(`wrote ${OUT}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAILED:', e); await prisma.$disconnect(); process.exit(1); });
