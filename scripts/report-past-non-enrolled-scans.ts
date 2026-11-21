/**
 * TAFSD-556 (read-only). Past biometric check-ins by students who were no longer
 * enrolled when they scanned, so the school can decide whether to backfill
 * attendance_non_enrolled_scans. Writes nothing.
 *
 * A student counts when their status today is one of NON_ENROLLED_FLAG_STATUSES
 * (LEFT, EXPELLED, GRADUATED) and the scan happened after they moved to it. The
 * move is the start of their open progression period with that change_type
 * (valid_from, a real UTC instant; scan_time is naive Pakistan time, hence the
 * +5h). Students with no such period have no known date: their scans are listed
 * apart, as "left date unknown", because some of those may be from before they
 * left. Duplicate double-taps are skipped, as the live check skips them.
 *
 * Statuses are today's, so a student who left and was later brought back is
 * not counted here even if they scanned while away.
 *
 * Run: npx ts-node scripts/report-past-non-enrolled-scans.ts [--csv out.csv]
 * Reads whatever DATABASE_URL points at.
 */
import { writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { NON_ENROLLED_FLAG_STATUSES } from '../src/modules/attendance/non-enrolled-scans/non-enrolled-scan.constants';

const prisma = new PrismaClient();

type Row = {
  student_cc: number;
  full_name: string | null;
  status: string;
  campus_code: string | null;
  left_at: Date | null;
  known: boolean;
  scans: bigint;
  days: bigint;
  first_day: Date;
  last_day: Date;
};

async function main() {
  const csvAt = process.argv.indexOf('--csv');
  const csvPath = csvAt > 0 ? process.argv[csvAt + 1] : undefined;
  const statuses = [...NON_ENROLLED_FLAG_STATUSES];

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `
    WITH quit AS (
      SELECT s.cc, s.full_name, s.status::text AS status, c.campus_code,
             (SELECT p.valid_from FROM student_progression_periods p
               WHERE p.student_cc = s.cc AND p.valid_to IS NULL AND p.change_type = s.status::text
               ORDER BY p.valid_from DESC LIMIT 1) AS left_at
        FROM students s
        LEFT JOIN campuses c ON c.id = s.campus_id
       WHERE s.status::text = ANY($1::text[])
    )
    SELECT q.cc AS student_cc, q.full_name, q.status, q.campus_code, q.left_at,
           (q.left_at IS NOT NULL) AS known,
           COUNT(*) AS scans,
           COUNT(DISTINCT z.attendance_date) AS days,
           MIN(z.attendance_date) AS first_day,
           MAX(z.attendance_date) AS last_day
      FROM quit q
      JOIN zk_attendance_scans z
        ON z.student_cc = q.cc AND z.person_type = 'STUDENT' AND z.is_duplicate = false
     WHERE q.left_at IS NULL OR z.scan_time > q.left_at + interval '5 hours'
     GROUP BY q.cc, q.full_name, q.status, q.campus_code, q.left_at
     ORDER BY known DESC, last_day DESC
    `,
    statuses,
  );

  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
  const sum = (rs: Row[], k: 'scans' | 'days') => rs.reduce((n, r) => n + Number(r[k]), 0);
  const known = rows.filter((r) => r.known);
  const unknown = rows.filter((r) => !r.known);

  const byStatus = new Map<string, { students: number; days: number; scans: number }>();
  for (const r of known) {
    const b = byStatus.get(r.status) ?? { students: 0, days: 0, scans: 0 };
    b.students++;
    b.days += Number(r.days);
    b.scans += Number(r.scans);
    byStatus.set(r.status, b);
  }
  const byCampus = new Map<string, number>();
  for (const r of known) byCampus.set(r.campus_code ?? '—', (byCampus.get(r.campus_code ?? '—') ?? 0) + 1);

  console.log(`Statuses flagged: ${statuses.join(', ')}`);
  console.log(`\nScanned after their recorded leaving date: ${known.length} students, ${sum(known, 'days')} student-days, ${sum(known, 'scans')} scans`);
  for (const [s, b] of byStatus) console.log(`  ${s}: ${b.students} students, ${b.days} days, ${b.scans} scans`);
  console.log(`  by campus: ${[...byCampus].map(([c, n]) => `${c} ${n}`).join(', ')}`);
  if (known.length) {
    console.log(`  earliest day ${day(known.reduce((a, r) => (r.first_day < a ? r.first_day : a), known[0].first_day))}, latest ${day(known.reduce((a, r) => (r.last_day > a ? r.last_day : a), known[0].last_day))}`);
  }
  console.log(`\nLeaving date unknown (any scan counted, some may predate leaving): ${unknown.length} students, ${sum(unknown, 'days')} days, ${sum(unknown, 'scans')} scans`);

  console.log('\nMost recent (known leaving date):');
  for (const r of known.slice(0, 15)) {
    console.log(`  CC ${r.student_cc} ${r.status} since ${day(r.left_at)} ${r.campus_code ?? ''}: ${r.days} day(s), last ${day(r.last_day)}`);
  }

  if (csvPath) {
    const header = 'cc,name,status,campus,left_at,left_date_known,scans,days,first_day,last_day';
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.student_cc, r.full_name, r.status, r.campus_code, day(r.left_at), r.known, r.scans, r.days, day(r.first_day), day(r.last_day)]
        .map(esc)
        .join(','),
    );
    writeFileSync(csvPath, [header, ...lines].join('\n'));
    console.log(`\nWrote ${rows.length} rows to ${csvPath}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
