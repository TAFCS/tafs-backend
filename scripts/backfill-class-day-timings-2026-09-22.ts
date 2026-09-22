/**
 * Backfill the campus+class school-day timings from the timings sheet.
 *
 *   Start   per the sheet — 08:45 for P.N. and Nursery, 07:45 for everyone else.
 *   End     per the sheet — Mon–Thu on the base row, Friday as a day override.
 *   Cut-off end − 1 hour, on both.
 *
 * The sheet gives Friday an end time only, so Friday keeps the same start as
 * the rest of the week; only the finish moves an hour earlier.
 *
 * Only classes on the sheet (PN → O-III) are touched. GEJ's secondary and
 * A-level classes are not on it and are deliberately left alone.
 *
 * Idempotent: re-running updates the same rows rather than stacking new
 * effective_from generations. Dry run by default —
 *   npx ts-node --transpile-only scripts/backfill-class-day-timings-2026-09-22.ts
 *   APPLY=1 npx ts-node --transpile-only scripts/backfill-class-day-timings-2026-09-22.ts
 *
 * Sends NO parent notifications: it writes rows directly and never goes through
 * ClassTimingNotificationService.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.env.APPLY === '1';

/** The date these timings are treated as having taken effect from. */
const EFFECTIVE_FROM = new Date(Date.UTC(2026, 8, 22)); // 2026-09-22
const GRACE_MINUTES = 10;
const FRIDAY = 5;

/** class_code -> start, Mon–Thu end, Friday end. Times are 24h. */
const SHEET: Record<string, { start: string; weekEnd: string; fridayEnd: string }> = {
  PN:    { start: '08:45', weekEnd: '12:30', fridayEnd: '11:30' },
  NUR:   { start: '08:45', weekEnd: '12:30', fridayEnd: '11:30' },
  KG:    { start: '07:45', weekEnd: '12:30', fridayEnd: '11:30' },
  JRI:   { start: '07:45', weekEnd: '12:30', fridayEnd: '11:30' },
  JRII:  { start: '07:45', weekEnd: '12:30', fridayEnd: '11:30' },
  JRIII: { start: '07:45', weekEnd: '13:30', fridayEnd: '12:30' },
  JRIV:  { start: '07:45', weekEnd: '13:30', fridayEnd: '12:30' },
  JRV:   { start: '07:45', weekEnd: '13:30', fridayEnd: '12:30' },
  SRI:   { start: '07:45', weekEnd: '13:30', fridayEnd: '12:30' },
  SRII:  { start: '07:45', weekEnd: '13:30', fridayEnd: '12:30' },
  SRIII: { start: '07:45', weekEnd: '13:30', fridayEnd: '12:30' },
  OI:    { start: '07:45', weekEnd: '13:30', fridayEnd: '12:30' },
  OII:   { start: '07:45', weekEnd: '13:30', fridayEnd: '12:30' },
  OIII:  { start: '07:45', weekEnd: '13:30', fridayEnd: '12:30' },
};

const toTime = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
const hhmm = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : '—');

/** end − 1 hour, as the internal punch cut-off. */
function minusOneHour(hhmmStr: string): string {
  const [h, m] = hhmmStr.split(':').map(Number);
  const shifted = (h + 23) % 24; // −1h, wrapping defensively
  return `${String(shifted).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function main() {
  console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN (set APPLY=1 to write) ===\n');

  const classes = await prisma.classes.findMany({ select: { id: true, class_code: true, description: true } });
  const byCode = new Map(classes.map((c) => [c.class_code, c]));

  const pairings = await prisma.campus_classes.findMany({
    where: { is_active: true },
    select: { campus_id: true, class_id: true, campuses: { select: { campus_code: true } } },
    orderBy: [{ campus_id: 'asc' }, { class_id: 'asc' }],
  });

  let planned = 0;
  const skipped: string[] = [];

  for (const pairing of pairings) {
    const klass = classes.find((c) => c.id === pairing.class_id);
    const sheet = klass?.class_code ? SHEET[klass.class_code] : undefined;
    if (!sheet) {
      skipped.push(`${pairing.campuses.campus_code}/${klass?.class_code ?? pairing.class_id}`);
      continue;
    }

    const weekCut = minusOneHour(sheet.weekEnd);
    const fridayCut = minusOneHour(sheet.fridayEnd);
    const label = `${pairing.campuses.campus_code} ${klass!.class_code.padEnd(6)}`;

    const existing = await prisma.class_check_in_schedules.findUnique({
      where: {
        campus_id_class_id_effective_from: {
          campus_id: pairing.campus_id,
          class_id: pairing.class_id,
          effective_from: EFFECTIVE_FROM,
        },
      },
      include: { class_check_in_schedule_days: true },
    });

    const verb = existing ? 'update' : 'create';
    console.log(
      `${verb.padEnd(6)} ${label} base ${sheet.start}–${sheet.weekEnd} cut ${weekCut}  |  Fri ${sheet.start}–${sheet.fridayEnd} cut ${fridayCut}` +
        (existing ? `   (was base ${hhmm(existing.expected_check_in)}–${hhmm(existing.end_time)} cut ${hhmm(existing.intermediate_time)})` : ''),
    );
    planned++;

    if (!APPLY) continue;

    const schedule = await prisma.class_check_in_schedules.upsert({
      where: {
        campus_id_class_id_effective_from: {
          campus_id: pairing.campus_id,
          class_id: pairing.class_id,
          effective_from: EFFECTIVE_FROM,
        },
      },
      create: {
        campus_id: pairing.campus_id,
        class_id: pairing.class_id,
        expected_check_in: toTime(sheet.start),
        end_time: toTime(sheet.weekEnd),
        intermediate_time: toTime(weekCut),
        late_grace_minutes: GRACE_MINUTES,
        effective_from: EFFECTIVE_FROM,
        created_by: 'backfill-2026-09-22',
      },
      update: {
        expected_check_in: toTime(sheet.start),
        end_time: toTime(sheet.weekEnd),
        intermediate_time: toTime(weekCut),
      },
    });

    await prisma.class_check_in_schedule_days.upsert({
      where: {
        schedule_id_day_of_week: { schedule_id: schedule.id, day_of_week: FRIDAY },
      },
      create: {
        schedule_id: schedule.id,
        day_of_week: FRIDAY,
        expected_check_in: toTime(sheet.start),
        end_time: toTime(sheet.fridayEnd),
        intermediate_time: toTime(fridayCut),
      },
      update: {
        expected_check_in: toTime(sheet.start),
        end_time: toTime(sheet.fridayEnd),
        intermediate_time: toTime(fridayCut),
      },
    });
  }

  console.log(`\n${APPLY ? 'Wrote' : 'Would write'} ${planned} pairing(s).`);
  if (skipped.length) {
    console.log(`Not on the sheet, left alone (${skipped.length}): ${skipped.join(', ')}`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FAILED:', e);
  await prisma.$disconnect();
  process.exit(1);
});
