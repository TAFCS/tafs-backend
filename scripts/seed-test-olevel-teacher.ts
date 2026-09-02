/**
 * Creates TEST (O-Level) — timetable-payroll teacher with section timetable slots.
 *
 * Usage: npx ts-node scripts/seed-test-olevel-teacher.ts
 */
import { CheckInSource, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CAMPUS_ID = 1;
const SECTION_ID = 1;
const ACADEMIC_YEAR = '2026-2027';
const EMPLOYEE_CODE = 'TEST-OLEVEL';
const FULL_NAME = 'TEST (O-Level)';
const CLASS_CODE = 'OI';
const SUBJECT_NAME = 'MATHEMATICS';
const SUBJECT_SYSTEM = 'O-Level';

/** Monday + Saturday period 1 */
const SLOTS: Array<{ day_of_week: number; block_number: number }> = [
  { day_of_week: 1, block_number: 1 },
  { day_of_week: 6, block_number: 1 },
];

function timeOfDay(hh: number, mm: number): Date {
  return new Date(Date.UTC(1970, 0, 1, hh, mm, 0));
}

async function main() {
  console.log('Seeding test O-Level teacher TEST-OLEVEL (Mon + Sat, period 1)...');

  const classRow = await prisma.classes.findFirst({
    where: { class_code: CLASS_CODE },
    select: { id: true, class_code: true },
  });
  if (!classRow) {
    throw new Error(`Class "${CLASS_CODE}" not found — run main seeds first.`);
  }

  const subject = await prisma.subjects.findFirst({
    where: { name: SUBJECT_NAME, academic_system: SUBJECT_SYSTEM },
    select: { id: true, name: true },
  });
  if (!subject) {
    throw new Error(`Subject "${SUBJECT_NAME}" (${SUBJECT_SYSTEM}) not found.`);
  }

  let employee = await prisma.employee_profiles.findFirst({
    where: { OR: [{ employee_code: EMPLOYEE_CODE }, { full_name: FULL_NAME }] },
  });

  if (employee) {
    employee = await prisma.employee_profiles.update({
      where: { id: employee.id },
      data: {
        employee_code: EMPLOYEE_CODE,
        full_name: FULL_NAME,
        campus_id: CAMPUS_ID,
        job_title: 'O-Level Test Teacher',
        employment_status: 'ACTIVE',
        check_in_source: CheckInSource.TIMETABLE,
        notes: 'Seeded by scripts/seed-test-olevel-teacher.ts — safe to delete.',
      },
    });
    console.log(`Updated employee #${employee.id} (${FULL_NAME})`);
  } else {
    employee = await prisma.employee_profiles.create({
      data: {
        employee_code: EMPLOYEE_CODE,
        full_name: FULL_NAME,
        campus_id: CAMPUS_ID,
        job_title: 'O-Level Test Teacher',
        employment_status: 'ACTIVE',
        check_in_source: CheckInSource.TIMETABLE,
        notes: 'Seeded by scripts/seed-test-olevel-teacher.ts — safe to delete.',
      },
    });
    console.log(`Created employee #${employee.id} (${FULL_NAME})`);
  }

  await prisma.campus_classes.upsert({
    where: {
      campus_id_class_id: { campus_id: CAMPUS_ID, class_id: classRow.id },
    },
    update: {},
    create: { campus_id: CAMPUS_ID, class_id: classRow.id },
  });

  await prisma.campus_sections.upsert({
    where: {
      campus_id_class_id_section_id: {
        campus_id: CAMPUS_ID,
        class_id: classRow.id,
        section_id: SECTION_ID,
      },
    },
    update: {},
    create: { campus_id: CAMPUS_ID, class_id: classRow.id, section_id: SECTION_ID },
  });

  await prisma.class_timetable_periods.upsert({
    where: {
      campus_id_class_id_block_number: {
        campus_id: CAMPUS_ID,
        class_id: classRow.id,
        block_number: 1,
      },
    },
    update: {
      start_time: timeOfDay(8, 0),
      end_time: timeOfDay(9, 0),
      label: '8:00-9:00',
      is_break: false,
    },
    create: {
      campus_id: CAMPUS_ID,
      class_id: classRow.id,
      block_number: 1,
      start_time: timeOfDay(8, 0),
      end_time: timeOfDay(9, 0),
      label: '8:00-9:00',
      is_break: false,
    },
  });

  const timetable = await prisma.timetables.upsert({
    where: {
      campus_id_class_id_section_id_academic_year: {
        campus_id: CAMPUS_ID,
        class_id: classRow.id,
        section_id: SECTION_ID,
        academic_year: ACADEMIC_YEAR,
      },
    },
    update: { is_active: true, effective_from: new Date('2026-08-01') },
    create: {
      campus_id: CAMPUS_ID,
      class_id: classRow.id,
      section_id: SECTION_ID,
      academic_year: ACADEMIC_YEAR,
      effective_from: new Date('2026-08-01'),
      is_active: true,
    },
  });

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (const slot of SLOTS) {
    await prisma.timetable_slots.upsert({
      where: {
        timetable_id_day_of_week_block_number_slot_order: {
          timetable_id: timetable.id,
          day_of_week: slot.day_of_week,
          block_number: slot.block_number,
          slot_order: 1,
        },
      },
      update: {
        subject_id: subject.id,
        employee_id: employee.id,
      },
      create: {
        timetable_id: timetable.id,
        day_of_week: slot.day_of_week,
        block_number: slot.block_number,
        slot_order: 1,
        subject_id: subject.id,
        employee_id: employee.id,
      },
    });
    console.log(
      `  Slot: ${dayNames[slot.day_of_week]} period ${slot.block_number} (8:00–9:00)`,
    );
  }

  console.log('\nDone.');
  console.log(`  Teacher: ${FULL_NAME} (employee #${employee.id}, code ${EMPLOYEE_CODE})`);
  console.log(`  Timetable: #${timetable.id} — ${CLASS_CODE} section A`);
  console.log('  Use Staff Lesson Reschedules → pick TEST (O-Level) to test staff excuse.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
