/**
 * First-pass seed of teaching_groups from the two source schedules:
 *   - timetables/TEACHERS TIMETABLE OF O LEVEL (2).pdf  (O-Level + SR-I/II/III)
 *   - timetables/FACULTY TIME TABLE SESSION 25-26.xlsx  (A-Level / TAFSAL)
 *
 * This only creates the teaching_groups "shells" (teacher + subject + class,
 * scoped to Gulistan-e-Johar Campus, the campus that actually offers AS/A2 and
 * whose staff records matched the O-Level teacher names below). It does NOT
 * populate timetable_slots or student_subject_enrollments -- those are a
 * deliberate later step once real subject-choice data has been entered via
 * the admin UI (see TIMETABLE_PLAN follow-up, Plan D sequencing).
 *
 * Several A-Level (TAFSAL) teacher names from the xlsx have no matching
 * employee_profiles row yet (HR hasn't onboarded them) -- those are skipped
 * and logged, not fabricated. Re-run this script after onboarding to fill
 * them in (upsert is idempotent).
 *
 * Run: npx ts-node prisma/seed-teaching-groups.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CAMPUS_ID = 1; // Gulistan-e-Johar Campus
const ACADEMIC_YEAR = '2026-2027';

const CAMBRIDGE = 'Cambridge'; // subjects.academic_system for O-Level/SR classes
const A_LEVEL = 'A-Level';

type Entry = {
  teacherNameContains: string;
  subjectName: string;
  subjectSystem: string;
  classCodes: string[]; // classes.class_code
};

const ENTRIES: Entry[] = [
  { teacherNameContains: 'ZAHID ANWAR', subjectName: 'ENGLISH', subjectSystem: CAMBRIDGE, classCodes: ['OIII'] },
  { teacherNameContains: 'AAMIR MUKHTAR', subjectName: 'ACCOUNTING', subjectSystem: CAMBRIDGE, classCodes: ['OI', 'OII', 'OIII'] },
  { teacherNameContains: 'SARAH KAUSAR', subjectName: 'MATHEMATICS', subjectSystem: CAMBRIDGE, classCodes: ['OI', 'OII', 'SRIII'] },
  { teacherNameContains: 'MUHAMMAD ASIM', subjectName: 'COMPUTER SCIENCE', subjectSystem: CAMBRIDGE, classCodes: ['OI', 'OII', 'OIII', 'SRI', 'SRII', 'SRIII'] },
  { teacherNameContains: 'ZEHRA SALIM', subjectName: 'PAKISTAN STUDIES', subjectSystem: CAMBRIDGE, classCodes: ['OI', 'OII'] },
  { teacherNameContains: 'TANVEER AHMED', subjectName: 'PHYSICS', subjectSystem: CAMBRIDGE, classCodes: ['OIII'] },
  { teacherNameContains: 'SADAF SHAHEEN', subjectName: 'CHEMISTRY', subjectSystem: CAMBRIDGE, classCodes: ['OI', 'OII', 'OIII'] },
  { teacherNameContains: 'AROOBA GHOURI', subjectName: 'BIOLOGY', subjectSystem: CAMBRIDGE, classCodes: ['OI', 'OII', 'OIII'] },
  { teacherNameContains: 'ZUBAIR JAWAID', subjectName: 'MATHEMATICS', subjectSystem: CAMBRIDGE, classCodes: ['OIII'] },
  { teacherNameContains: 'SYED MUHAMMAD DANIYAL ILYAS', subjectName: 'ECONOMICS', subjectSystem: CAMBRIDGE, classCodes: ['OI', 'OII', 'OIII'] },
  { teacherNameContains: 'SABIHA MAZHAR', subjectName: 'URDU', subjectSystem: CAMBRIDGE, classCodes: ['OI', 'OII'] },
  { teacherNameContains: 'MUHAMMAD UNAIS', subjectName: 'BUSINESS STUDIES', subjectSystem: CAMBRIDGE, classCodes: ['OI', 'OII', 'OIII'] },
  { teacherNameContains: 'SYEDA SABIKAH HASSAN NAQVI', subjectName: 'ENGLISH', subjectSystem: CAMBRIDGE, classCodes: ['OI', 'OII', 'SRIII'] },

  // A-Level (TAFSAL) -- only teachers who already have an employee_profiles row.
  { teacherNameContains: 'ZUBAIR JAWAID', subjectName: 'MATHEMATICS', subjectSystem: A_LEVEL, classCodes: ['AS'] },
];

// A-Level (TAFSAL) teachers from the xlsx with NO employee_profiles match yet.
// Not seeded -- create their HR/employee records first, then re-run this script.
const UNMATCHED_A_LEVEL_TEACHERS = [
  'SIR MANSOOR ALI KHAN (subject unconfirmed, likely Mathematics A2)',
  'SIR QAMAR HUSSAIN (Physics)',
  'SIR ABDUL REHMAN (Chemistry)',
  'SIR NOMAN (Biology)',
  'SIR AQEEL AHMED (Computer Science)',
  'SIR ZEESHAN MALIK (Accounting)',
  'SIR HUSSAIN RAZA (Economics)',
  'SIR TAIMOOR SHAHID (Business)',
  'SIR ADEEL (subject unconfirmed)',
  'SIR GHULAM MUSTAFA (subject unconfirmed)',
];

// O-Level teachers from the PDF with no employee_profiles match yet.
const UNMATCHED_O_LEVEL_TEACHERS = [
  'MS. TABASSUM SIKANDER (Islamiyat O-I & O-II)',
  'SIR KASHIF KHAN (Physics O-I & O-II)',
];

async function main() {
  console.log(`Seeding teaching_groups for campus #${CAMPUS_ID}, academic year ${ACADEMIC_YEAR}...`);

  const classes = await prisma.classes.findMany({
    select: { id: true, class_code: true },
  });
  const classByCode = new Map(classes.map((c) => [c.class_code, c.id]));

  let created = 0;
  let skipped = 0;

  for (const entry of ENTRIES) {
    const employee = await prisma.employee_profiles.findFirst({
      where: { full_name: { contains: entry.teacherNameContains, mode: 'insensitive' } },
      select: { id: true, full_name: true },
    });
    if (!employee) {
      console.warn(`  SKIP: no employee_profiles match for "${entry.teacherNameContains}"`);
      skipped++;
      continue;
    }

    const subject = await prisma.subjects.findFirst({
      where: { name: entry.subjectName, academic_system: entry.subjectSystem },
      select: { id: true, name: true },
    });
    if (!subject) {
      console.warn(`  SKIP: no subject "${entry.subjectName}" (${entry.subjectSystem})`);
      skipped++;
      continue;
    }

    for (const code of entry.classCodes) {
      const classId = classByCode.get(code);
      if (!classId) {
        console.warn(`  SKIP: no class with class_code "${code}"`);
        skipped++;
        continue;
      }

      await prisma.teaching_groups.upsert({
        where: {
          campus_id_class_id_subject_id_employee_id_academic_year: {
            campus_id: CAMPUS_ID,
            class_id: classId,
            subject_id: subject.id,
            employee_id: employee.id,
            academic_year: ACADEMIC_YEAR,
          },
        },
        update: { is_active: true },
        create: {
          campus_id: CAMPUS_ID,
          class_id: classId,
          subject_id: subject.id,
          employee_id: employee.id,
          academic_year: ACADEMIC_YEAR,
        },
      });
      created++;
      console.log(`  OK: ${employee.full_name} — ${subject.name} — ${code}`);
    }
  }

  console.log(`\nDone. ${created} teaching group(s) created/confirmed, ${skipped} entries skipped.`);
  if (UNMATCHED_A_LEVEL_TEACHERS.length + UNMATCHED_O_LEVEL_TEACHERS.length > 0) {
    console.log('\nTeachers with no employee_profiles record (onboard in HR, then re-run this script):');
    [...UNMATCHED_A_LEVEL_TEACHERS, ...UNMATCHED_O_LEVEL_TEACHERS].forEach((t) => console.log(`  - ${t}`));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
