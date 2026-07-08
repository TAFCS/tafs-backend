/**
 * Seed the 8 fixed daily timetable blocks (8:00–9:00 … 15:00–16:00).
 * Shared by every class-section timetable.
 *
 * Run: npx ts-node prisma/seed-timetable-blocks.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Wall-clock HH:MM → Date with UTC time components (Prisma @db.Time convention). */
function timeOfDay(hh: number, mm: number): Date {
  return new Date(Date.UTC(1970, 0, 1, hh, mm, 0));
}

const BLOCKS: Array<{
  block_number: number;
  start_h: number;
  start_m: number;
  end_h: number;
  end_m: number;
  label: string;
}> = [
  { block_number: 1, start_h: 8, start_m: 0, end_h: 9, end_m: 0, label: '8:00-9:00' },
  { block_number: 2, start_h: 9, start_m: 0, end_h: 10, end_m: 0, label: '9:00-10:00' },
  { block_number: 3, start_h: 10, start_m: 0, end_h: 11, end_m: 0, label: '10:00-11:00' },
  { block_number: 4, start_h: 11, start_m: 0, end_h: 12, end_m: 0, label: '11:00-12:00' },
  { block_number: 5, start_h: 12, start_m: 0, end_h: 13, end_m: 0, label: '12:00-1:00' },
  { block_number: 6, start_h: 13, start_m: 0, end_h: 14, end_m: 0, label: '1:00-2:00' },
  { block_number: 7, start_h: 14, start_m: 0, end_h: 15, end_m: 0, label: '2:00-3:00' },
  { block_number: 8, start_h: 15, start_m: 0, end_h: 16, end_m: 0, label: '3:00-4:00' },
];

async function main() {
  console.log('Seeding timetable_blocks...');
  let upserted = 0;

  for (const b of BLOCKS) {
    await prisma.timetable_blocks.upsert({
      where: { block_number: b.block_number },
      update: {
        start_time: timeOfDay(b.start_h, b.start_m),
        end_time: timeOfDay(b.end_h, b.end_m),
        label: b.label,
      },
      create: {
        block_number: b.block_number,
        start_time: timeOfDay(b.start_h, b.start_m),
        end_time: timeOfDay(b.end_h, b.end_m),
        label: b.label,
      },
    });
    upserted++;
  }

  console.log(`Done. Upserted ${upserted} timetable blocks.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
