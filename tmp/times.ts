import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const t = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : '—');
(async () => {
  const all = await p.employee_profiles.findMany({
    select: { id: true, employee_code: true, full_name: true, employment_status: true, check_in_source: true, reporting_time: true, leaving_time: true, job_title: true,
      campuses: { select: { campus_name: true } }, staff_categories: { select: { name: true } }, departments: { select: { name: true } } },
  });
  const by = (f: (e: (typeof all)[number]) => boolean) => all.filter(f).length;
  console.log(`employees: ${all.length}   ACTIVE: ${by(e => e.employment_status === 'ACTIVE')}`);
  console.log(`FIXED: ${by(e => e.check_in_source === 'FIXED')}  TIMETABLE: ${by(e => e.check_in_source === 'TIMETABLE')}`);
  console.log(`both times set: ${by(e => !!e.reporting_time && !!e.leaving_time)}   only reporting: ${by(e => !!e.reporting_time && !e.leaving_time)}   only leaving: ${by(e => !e.reporting_time && !!e.leaving_time)}   neither: ${by(e => !e.reporting_time && !e.leaving_time)}`);
  const bad = all.filter(e => e.reporting_time && e.leaving_time && e.reporting_time > e.leaving_time);
  const eq = all.filter(e => e.reporting_time && e.leaving_time && e.reporting_time.getTime() === e.leaving_time.getTime());
  console.log(`\nreporting AFTER leaving: ${bad.length}   reporting EQUAL to leaving: ${eq.length}`);
  console.log('\ncode            name                     status  source    report leave  span   title / category');
  [...bad, ...eq].sort((a, b) => String(a.employee_code).localeCompare(String(b.employee_code))).forEach(e => {
    const span = ((e.leaving_time!.getTime() - e.reporting_time!.getTime()) / 3600000);
    console.log(`${String(e.employee_code).padEnd(15)} ${e.full_name.slice(0, 24).padEnd(24)} ${e.employment_status.padEnd(7)} ${e.check_in_source.padEnd(9)} ${t(e.reporting_time)}  ${t(e.leaving_time)}  ${span.toFixed(1).padStart(5)}h ${e.job_title ?? ''} / ${e.staff_categories?.name ?? ''}`);
  });
  await p.$disconnect();
})().catch(async e => { console.error(e.message); await p.$disconnect(); });
