/**
 * Populate real weekly timetable_slots for the teaching_groups seeded by
 * seed-teaching-groups.ts, sourced from the two schedule sheets:
 *   - timetables/TEACHERS TIMETABLE OF O LEVEL (2).pdf
 *   - timetables/FACULTY TIME TABLE SESSION 25-26.xlsx
 *
 * The (block, day, class-cell) data below was extracted programmatically
 * from each file's exact text positions (pdfjs-dist for the PDF, xlsx for
 * the spreadsheet) -- not manually transcribed -- to avoid transposition
 * errors. Re-derive by re-running the parse if the source files change.
 *
 * Two A-Level (TAFSAL) staff are intentionally excluded:
 *   - SIR ADEEL: no AS/A2 cells in his grid at all.
 *   - SIR GHULAM MUSTAFA: his cells read "CHEMISTRY/PHYSICS/BIOLOGY
 *     PRACTICAL", not a class -- lab-practical support, doesn't fit the
 *     one-subject-one-class teaching_groups model as-is (see
 *     seed-teaching-groups.ts's UNMATCHED_A_LEVEL_TEACHERS comment).
 *
 * Run: npx ts-node prisma/seed-timetable-slots.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CAMPUS_ID = 1; // Gulistan-e-Johar Campus
const ACADEMIC_YEAR = '2026-2027';

type RawSlot = { block: number; day: number; value: string };
type TeacherBlock = { teacherNameContains: string; slots: RawSlot[] };

// day: 1=Mon .. 6=Sat (matches timetable_slots.day_of_week convention)
const TEACHER_BLOCKS: TeacherBlock[] = [
  // ── O-Level (TEACHERS TIMETABLE OF O LEVEL (2).pdf) ──
  { teacherNameContains: 'ZAHID ANWAR', slots: [
    { block: 4, day: 1, value: 'O-III' }, { block: 4, day: 2, value: 'O-III' },
    { block: 5, day: 1, value: 'O-III' }, { block: 5, day: 2, value: 'O-III' },
  ]},
  { teacherNameContains: 'AAMIR MUKHTAR', slots: [
    { block: 3, day: 1, value: 'O-III' }, { block: 3, day: 2, value: 'O-III' }, { block: 3, day: 4, value: 'O-III' },
    { block: 4, day: 4, value: 'O-I B' },
    { block: 5, day: 1, value: 'O-II' }, { block: 5, day: 4, value: 'O-III' },
    { block: 6, day: 1, value: 'O-I B' }, { block: 6, day: 4, value: 'O-II' },
  ]},
  { teacherNameContains: 'SARAH KAUSAR', slots: [
    { block: 1, day: 1, value: 'SR. III B' }, { block: 1, day: 3, value: 'SR. III B' }, { block: 1, day: 5, value: 'O-II' },
    { block: 2, day: 1, value: 'SR. III A' }, { block: 2, day: 2, value: 'SR. III A' }, { block: 2, day: 3, value: 'O-I A' },
    { block: 2, day: 4, value: 'SR. III B' }, { block: 2, day: 5, value: 'O-I A' },
    { block: 3, day: 1, value: 'O-I A' }, { block: 3, day: 3, value: 'O-II' }, { block: 3, day: 5, value: 'O-I B' },
    { block: 4, day: 2, value: 'SR. III B' }, { block: 4, day: 3, value: 'O-I B' }, { block: 4, day: 4, value: 'SR. III A' },
    { block: 5, day: 1, value: 'O-I B' }, { block: 5, day: 4, value: 'O-I A' },
    { block: 6, day: 1, value: 'O-II' }, { block: 6, day: 2, value: 'O-I B' }, { block: 6, day: 3, value: 'SR. III A' },
  ]},
  { teacherNameContains: 'MUHAMMAD ASIM', slots: [
    // Moin Asim (O-I & O-II) + Sir Asim (O-III) -- same employee record.
    { block: 1, day: 1, value: 'O-I A' }, { block: 1, day: 2, value: 'SR. I B' }, { block: 1, day: 3, value: 'O-I A' },
    { block: 1, day: 4, value: 'SR. I A' }, { block: 1, day: 5, value: 'SR. III B' },
    { block: 2, day: 1, value: 'O-II' }, { block: 2, day: 2, value: 'O-II' },
    { block: 3, day: 1, value: 'SR. I A' }, { block: 3, day: 3, value: 'SR. II B' }, { block: 3, day: 4, value: 'SR. I B' }, { block: 3, day: 5, value: 'SR. III A' },
    { block: 4, day: 1, value: 'SR. II B' }, { block: 4, day: 3, value: 'SR. II A' },
    { block: 5, day: 1, value: 'SR. II A' }, { block: 5, day: 3, value: 'SR. I C' }, { block: 5, day: 4, value: 'SR. I C' },
    { block: 6, day: 2, value: 'SR. III B' }, { block: 6, day: 4, value: 'SR. III A' },
    { block: 1, day: 1, value: 'O-III' }, { block: 1, day: 3, value: 'O-III' },
    { block: 2, day: 1, value: 'O-III' }, { block: 2, day: 3, value: 'O-III' },
  ]},
  { teacherNameContains: 'TABASSUM SIKANDER', slots: [
    { block: 1, day: 2, value: 'O-II' }, { block: 1, day: 4, value: 'O-II' }, { block: 1, day: 5, value: 'O-I B' },
    { block: 2, day: 2, value: 'O-I A' }, { block: 2, day: 4, value: 'O-I A' }, { block: 2, day: 5, value: 'O-I B' },
    { block: 3, day: 2, value: 'O-I B' }, { block: 3, day: 4, value: 'O-I B' },
    { block: 4, day: 2, value: 'O-II' },
    { block: 5, day: 2, value: 'O-I A' }, { block: 5, day: 4, value: 'O-II' },
    { block: 6, day: 4, value: 'O-I A' },
  ]},
  { teacherNameContains: 'ZEHRA SALIM', slots: [
    { block: 1, day: 2, value: 'O-I A' }, { block: 1, day: 3, value: 'O-I B' },
    { block: 2, day: 2, value: 'O-I B' }, { block: 2, day: 3, value: 'O-II' },
    { block: 3, day: 2, value: 'O-I A' }, { block: 3, day: 3, value: 'O-I A' },
    { block: 4, day: 2, value: 'O-I B' }, { block: 4, day: 3, value: 'O-II' },
    { block: 5, day: 2, value: 'O-II' }, { block: 5, day: 3, value: 'O-I A' },
    { block: 6, day: 2, value: 'O-II' }, { block: 6, day: 3, value: 'O-I B' },
  ]},
  { teacherNameContains: 'TANVEER AHMED', slots: [
    { block: 3, day: 1, value: 'O-III' }, { block: 3, day: 2, value: 'O-III' }, { block: 3, day: 3, value: 'O-III' }, { block: 3, day: 4, value: 'O-III' },
  ]},
  { teacherNameContains: 'SADAF SHAHEEN', slots: [
    { block: 1, day: 2, value: 'O-III' }, { block: 1, day: 3, value: 'O-II' }, { block: 1, day: 4, value: 'O-III' },
    { block: 2, day: 2, value: 'O-III' }, { block: 2, day: 3, value: 'O-I B' }, { block: 2, day: 4, value: 'O-III' },
    { block: 3, day: 2, value: 'O-II' }, { block: 3, day: 4, value: 'O-I A' },
    { block: 4, day: 2, value: 'O-I A' }, { block: 4, day: 4, value: 'O-I B' },
  ]},
  { teacherNameContains: 'AROOBA GHOURI', slots: [
    { block: 1, day: 1, value: 'O-III' }, { block: 1, day: 2, value: 'O-I B' }, { block: 1, day: 3, value: 'O-III' },
    { block: 2, day: 1, value: 'O-III' }, { block: 2, day: 2, value: 'O-II' }, { block: 2, day: 3, value: 'O-III' },
    { block: 3, day: 1, value: 'O-II' }, { block: 3, day: 3, value: 'O-I B' },
  ]},
  { teacherNameContains: 'KASHIF KHAN', slots: [
    { block: 4, day: 1, value: 'O-I A' }, { block: 4, day: 3, value: 'O-I A' },
    { block: 5, day: 1, value: 'O-II' }, { block: 5, day: 3, value: 'O-I B' },
    { block: 6, day: 1, value: 'O-I B' }, { block: 6, day: 3, value: 'O-II' },
  ]},
  { teacherNameContains: 'SYED MUHAMMAD DANIYAL ILYAS', slots: [
    { block: 1, day: 1, value: 'O-I B' }, { block: 1, day: 3, value: 'O-II' }, { block: 1, day: 4, value: 'O-III' },
    { block: 2, day: 1, value: 'O-III' }, { block: 2, day: 3, value: 'O-III' }, { block: 2, day: 4, value: 'O-I B' },
    { block: 3, day: 1, value: 'O-II' }, { block: 3, day: 3, value: 'O-III' },
  ]},
  { teacherNameContains: 'SABIHA MAZHAR', slots: [
    { block: 1, day: 1, value: 'O-II' }, { block: 1, day: 4, value: 'O-I A' },
    { block: 2, day: 1, value: 'O-I B' }, { block: 2, day: 4, value: 'O-II' },
    { block: 3, day: 1, value: 'O-I B' }, { block: 3, day: 4, value: 'O-II' },
    { block: 4, day: 1, value: 'O-II' }, { block: 4, day: 4, value: 'O-I A' },
    { block: 5, day: 1, value: 'O-I A' }, { block: 5, day: 4, value: 'O-I B' },
    { block: 6, day: 1, value: 'O-I A' }, { block: 6, day: 4, value: 'O-I B' },
  ]},
  { teacherNameContains: 'MUHAMMAD UNAIS', slots: [
    { block: 1, day: 2, value: 'O-III' }, { block: 1, day: 3, value: 'O-III' },
    { block: 2, day: 2, value: 'O-III' }, { block: 2, day: 3, value: 'O-I B' }, { block: 2, day: 5, value: 'O-III' },
    { block: 3, day: 2, value: 'O-II' }, { block: 3, day: 3, value: 'O-I B' }, { block: 3, day: 5, value: 'O-II' },
  ]},
  { teacherNameContains: 'SYEDA SABIKAH HASSAN NAQVI', slots: [
    { block: 1, day: 1, value: 'SR. III A' }, { block: 1, day: 5, value: 'O-I A' },
    { block: 2, day: 2, value: 'SR. III B' }, { block: 2, day: 3, value: 'SR. III A' }, { block: 2, day: 5, value: 'O-II' },
    { block: 3, day: 1, value: 'SR. III B' }, { block: 3, day: 2, value: 'SR. III A' }, { block: 3, day: 3, value: 'SR. III B' },
    { block: 4, day: 1, value: 'O-I B' }, { block: 4, day: 4, value: 'O-II' }, { block: 4, day: 5, value: 'O-I B' },
    { block: 5, day: 2, value: 'O-I B' }, { block: 5, day: 3, value: 'O-II' }, { block: 5, day: 4, value: 'SR. III A' },
    { block: 6, day: 2, value: 'O-I A' }, { block: 6, day: 3, value: 'O-I A' }, { block: 6, day: 4, value: 'SR. III B' },
  ]},

  // ── A-Level / TAFSAL (FACULTY TIME TABLE SESSION 25-26.xlsx) ──
  { teacherNameContains: 'MANSOOR ALI KHAN', slots: [
    { block: 1, day: 5, value: 'A2' }, { block: 6, day: 1, value: 'A2' },
  ]},
  { teacherNameContains: 'QAMAR HUSSAIN', slots: [
    { block: 1, day: 6, value: 'A2' }, { block: 3, day: 6, value: 'AS' }, { block: 4, day: 5, value: 'AS' }, { block: 7, day: 5, value: 'A2' },
  ]},
  { teacherNameContains: 'ABDUL REHMAN', slots: [
    { block: 1, day: 6, value: 'AS' }, { block: 3, day: 6, value: 'A2' }, { block: 5, day: 2, value: 'AS' }, { block: 7, day: 2, value: 'A2' },
  ]},
  { teacherNameContains: 'ZUBAIR JAWAID', slots: [
    { block: 1, day: 5, value: 'AS' }, { block: 2, day: 5, value: 'AS' },
    { block: 3, day: 5, value: 'O-III' }, { block: 4, day: 3, value: 'O-III' }, { block: 4, day: 5, value: 'O-III' }, { block: 5, day: 3, value: 'O-III' },
    { block: 6, day: 3, value: 'AS' },
  ]},
  { teacherNameContains: 'NOMAN', slots: [
    { block: 5, day: 1, value: 'A2' }, { block: 5, day: 2, value: 'A2' }, { block: 5, day: 3, value: 'AS' }, { block: 7, day: 1, value: 'AS' },
  ]},
  { teacherNameContains: 'AQEEL AHMED', slots: [
    { block: 3, day: 5, value: 'A2' }, { block: 5, day: 1, value: 'A2' }, { block: 5, day: 6, value: 'AS' }, { block: 7, day: 1, value: 'AS' },
  ]},
  { teacherNameContains: 'ZEESHAN MALIK', slots: [
    { block: 4, day: 1, value: 'A2' }, { block: 4, day: 3, value: 'A2' }, { block: 6, day: 1, value: 'AS' }, { block: 6, day: 3, value: 'AS' },
  ]},
  { teacherNameContains: 'HUSSAIN RAZA', slots: [
    { block: 2, day: 3, value: 'A2' }, { block: 3, day: 4, value: 'A2' }, { block: 4, day: 3, value: 'AS' }, { block: 5, day: 4, value: 'AS' },
  ]},
  { teacherNameContains: 'TAIMOOR SHAHID', slots: [
    { block: 1, day: 4, value: 'A2' }, { block: 2, day: 6, value: 'A2' }, { block: 5, day: 1, value: 'AS' }, { block: 7, day: 4, value: 'AS' },
  ]},
];

/** "O-I A" / "O-I" / "OIII" / "SR. III B" / "AS" -> classes.class_code */
function normalizeClassCode(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/[\s.\-]/g, ''); // "SR. III B" -> "SRIIIB"
  const KNOWN_BASE = ['SRIII', 'SRII', 'SRI', 'OIII', 'OII', 'OI']; // longest-first match
  if (compact === 'AS' || compact === 'A2') return compact;

  for (const base of KNOWN_BASE) {
    if (compact === base) return base;
    if (compact === base + 'A' || compact === base + 'B' || compact === base + 'C') return base;
  }
  return null;
}

async function main() {
  console.log(`Populating timetable_slots for campus #${CAMPUS_ID}, academic year ${ACADEMIC_YEAR}...`);

  const classes = await prisma.classes.findMany({ select: { id: true, class_code: true } });
  const classByCode = new Map(classes.map((c) => [c.class_code, c.id]));

  let created = 0;
  let skipped = 0;
  const timetableIdByGroup = new Map<number, number>();

  // Dedupe exact (teacher, class, day, block) repeats across merged sources.
  const seen = new Set<string>();

  for (const teacherBlock of TEACHER_BLOCKS) {
    console.log(`Processing "${teacherBlock.teacherNameContains}" (${teacherBlock.slots.length} slots)...`);
    const employee = await prisma.employee_profiles.findFirst({
      where: { full_name: { contains: teacherBlock.teacherNameContains, mode: 'insensitive' } },
      select: { id: true, full_name: true },
    });
    if (!employee) {
      console.warn(`  SKIP TEACHER: no employee_profiles match for "${teacherBlock.teacherNameContains}"`);
      skipped += teacherBlock.slots.length;
      continue;
    }

    for (const raw of teacherBlock.slots) {
      const classCode = normalizeClassCode(raw.value);
      if (!classCode) {
        console.warn(`  SKIP: unrecognized class cell "${raw.value}" for ${employee.full_name}`);
        skipped++;
        continue;
      }
      const classId = classByCode.get(classCode);
      if (!classId) {
        console.warn(`  SKIP: no class with class_code "${classCode}"`);
        skipped++;
        continue;
      }

      const dedupeKey = `${employee.id}|${classId}|${raw.day}|${raw.block}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const group = await prisma.teaching_groups.findFirst({
        where: { campus_id: CAMPUS_ID, class_id: classId, employee_id: employee.id, academic_year: ACADEMIC_YEAR },
      });
      if (!group) {
        console.warn(`  SKIP: no teaching_group for ${employee.full_name} / class_code=${classCode}`);
        skipped++;
        continue;
      }

      // Reject if this teacher already has a slot at this day/block in a
      // DIFFERENT group (mirrors the double-booking guard in timetables.service.ts).
      const conflict = await prisma.timetable_slots.findFirst({
        where: {
          employee_id: employee.id,
          day_of_week: raw.day,
          block_number: raw.block,
          NOT: { timetables: { teaching_group_id: group.id } },
        },
        include: { timetables: true },
      });
      if (conflict) {
        console.warn(
          `  SKIP: ${employee.full_name} already booked day=${raw.day} block=${raw.block} in teaching_group #${conflict.timetables.teaching_group_id}`,
        );
        skipped++;
        continue;
      }

      let timetableId = timetableIdByGroup.get(group.id);
      if (!timetableId) {
        const timetable = await prisma.timetables.upsert({
          where: {
            campus_id_teaching_group_id_academic_year: {
              campus_id: CAMPUS_ID,
              teaching_group_id: group.id,
              academic_year: ACADEMIC_YEAR,
            },
          },
          update: {},
          create: {
            campus_id: CAMPUS_ID,
            class_id: group.class_id,
            teaching_group_id: group.id,
            academic_year: ACADEMIC_YEAR,
            effective_from: new Date(),
            is_active: true,
          },
        });
        timetableId = timetable.id;
        timetableIdByGroup.set(group.id, timetableId);
      }

      await prisma.timetable_slots.upsert({
        where: {
          timetable_id_day_of_week_block_number_slot_order: {
            timetable_id: timetableId,
            day_of_week: raw.day,
            block_number: raw.block,
            slot_order: 1,
          },
        },
        update: { subject_id: group.subject_id, employee_id: employee.id },
        create: {
          timetable_id: timetableId,
          day_of_week: raw.day,
          block_number: raw.block,
          slot_order: 1,
          subject_id: group.subject_id,
          employee_id: employee.id,
        },
      });
      created++;
    }
  }

  console.log(`\nDone. ${created} slot(s) created/confirmed, ${skipped} skipped.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
