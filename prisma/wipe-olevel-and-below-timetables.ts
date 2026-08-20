/**
 * One-off wipe of all timetable + teaching-group data for SR-I, SR-II,
 * SR-III, O-I, O-II, O-III (O-Level and the Cambridge classes below it) so
 * they can be rebuilt from scratch via the new campus+class+section
 * timetable UI. AS/A2 (A-Level) are untouched -- they stay on the
 * teaching-group model.
 *
 * Deleting teaching_groups cascades (per schema onDelete: Cascade) to:
 *   - timetables (teaching_group_id FK)
 *       - timetable_slots (timetable_id FK)
 *   - student_subject_enrollments (teaching_group_id FK)
 * A separate timetables deleteMany catches any class+section-scoped rows
 * that were never linked to a teaching_group.
 *
 * Run: npx ts-node prisma/wipe-olevel-and-below-timetables.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CLASS_IDS = [9, 10, 11, 12, 13, 14]; // SR-I, SR-II, SR-III, O-I, O-II, O-III

async function main() {
  const groups = await prisma.teaching_groups.deleteMany({
    where: { class_id: { in: CLASS_IDS } },
  });
  console.log(`Deleted ${groups.count} teaching_groups (cascaded their timetables/slots/enrollments).`);

  const remainingTimetables = await prisma.timetables.deleteMany({
    where: { class_id: { in: CLASS_IDS } },
  });
  console.log(`Deleted ${remainingTimetables.count} additional (non-group-linked) timetables rows.`);

  const remainingCount = await prisma.timetables.count({ where: { class_id: { in: CLASS_IDS } } });
  const remainingSlots = await prisma.timetable_slots.count({
    where: { timetables: { class_id: { in: CLASS_IDS } } },
  });
  console.log(`\nRemaining timetables for these classes: ${remainingCount}`);
  console.log(`Remaining timetable_slots for these classes: ${remainingSlots}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
