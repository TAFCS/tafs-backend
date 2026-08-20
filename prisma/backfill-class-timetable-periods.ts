/**
 * One-off backfill for class_timetable_periods, run once when the per-class
 * bell schedule replaced the single global timetable_blocks template.
 *
 * 1. Classes that already have timetables built (AS/A2/SR-I/SR-II/SR-III)
 *    get the previous global 8x1hr schedule copied in verbatim, so nothing
 *    changes for teachers already on TIMETABLE-derived check-in.
 * 2. O-I/O-II/O-III (O1/O2/O3) get their real bell schedule entered from the
 *    school's actual printed timetable, since they never matched the global
 *    8x1hr template to begin with.
 *
 * Run: npx ts-node prisma/backfill-class-timetable-periods.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CAMPUS_ID = 1; // Gulistan-e-Johar Campus

// Classes already scheduled under the old global 8x1hr template.
const GLOBAL_TEMPLATE_CLASS_IDS = [20, 21, 9, 10, 11]; // AS, A2, SR-I, SR-II, SR-III

type PeriodRow = {
  block_number: number;
  start: string; // "HH:MM"
  end: string;
  is_break?: boolean;
  label?: string;
};

// O-I (class 12) and O-II (class 13): identical real bell schedule.
const O1_O2_PERIODS: PeriodRow[] = [
  { block_number: 1, start: '08:00', end: '08:50' },
  { block_number: 2, start: '08:50', end: '09:40' },
  { block_number: 3, start: '09:40', end: '10:30' },
  { block_number: 4, start: '10:30', end: '11:00', is_break: true, label: 'BREAK' },
  { block_number: 5, start: '11:00', end: '11:50' },
  { block_number: 6, start: '11:50', end: '12:40' },
  { block_number: 7, start: '12:40', end: '13:30' },
];

// O-III (class 14): its own schedule -- 60-min periods, later/shorter break.
const O3_PERIODS: PeriodRow[] = [
  { block_number: 1, start: '08:00', end: '09:00' },
  { block_number: 2, start: '09:00', end: '10:00' },
  { block_number: 3, start: '10:00', end: '10:50' },
  { block_number: 4, start: '10:50', end: '11:10', is_break: true, label: 'BREAK' },
  { block_number: 5, start: '11:10', end: '12:00' },
  { block_number: 6, start: '12:00', end: '13:00' },
];

function toTime(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, h, m, 0));
}

async function upsertPeriod(campusId: number, classId: number, row: PeriodRow) {
  await prisma.class_timetable_periods.upsert({
    where: {
      campus_id_class_id_block_number: {
        campus_id: campusId,
        class_id: classId,
        block_number: row.block_number,
      },
    },
    update: {
      start_time: toTime(row.start),
      end_time: toTime(row.end),
      is_break: row.is_break ?? false,
      label: row.label ?? null,
    },
    create: {
      campus_id: campusId,
      class_id: classId,
      block_number: row.block_number,
      start_time: toTime(row.start),
      end_time: toTime(row.end),
      is_break: row.is_break ?? false,
      label: row.label ?? null,
    },
  });
}

async function main() {
  const globalBlocks = await prisma.timetable_blocks.findMany({ orderBy: { block_number: 'asc' } });

  for (const classId of GLOBAL_TEMPLATE_CLASS_IDS) {
    for (const block of globalBlocks) {
      await upsertPeriod(CAMPUS_ID, classId, {
        block_number: block.block_number,
        start: block.start_time.toISOString().slice(11, 16),
        end: block.end_time.toISOString().slice(11, 16),
        label: block.label ?? undefined,
      });
    }
    console.log(`OK: backfilled global 8x1hr template for class #${classId} at campus #${CAMPUS_ID}`);
  }

  for (const row of O1_O2_PERIODS) {
    await upsertPeriod(CAMPUS_ID, 12, row); // O-I
    await upsertPeriod(CAMPUS_ID, 13, row); // O-II
  }
  console.log(`OK: seeded real bell schedule for O-I (#12) and O-II (#13) at campus #${CAMPUS_ID}`);

  for (const row of O3_PERIODS) {
    await upsertPeriod(CAMPUS_ID, 14, row); // O-III
  }
  console.log(`OK: seeded real bell schedule for O-III (#14) at campus #${CAMPUS_ID}`);

  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
