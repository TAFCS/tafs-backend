/**
 * Backfill employee_profiles for teachers who appear in the O-Level and
 * A-Level (TAFSAL) schedule sheets but have no HR record yet. Name-only
 * placeholder rows -- mirrors the existing sparse "O LEVEL FACULTY" rows
 * already in the table (e.g. ZUBAIR JAWAID, SADAF SHAHEEN), but sets
 * staff_category_id/department_id/campus_id so they're usable in the
 * teacher pickers (SlotEditorModal / New Teaching Group modal filter on
 * staff_categories.code, which null-category rows fail).
 *
 * Idempotent: matches by full_name before creating.
 *
 * Run: npx ts-node prisma/seed-backfill-teachers.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CAMPUS_ID = 1; // Gulistan-e-Johar Campus
const TEACHER_CATEGORY_ID = 1; // staff_categories.code = 'TEACHER'
const ACADEMICS_DEPARTMENT_ID = 6;

type Placeholder = {
  full_name: string;
  job_title: 'O LEVEL FACULTY' | 'A LEVEL FACULTY';
};

const TEACHERS: Placeholder[] = [
  // A-Level (TAFSAL) -- from FACULTY TIME TABLE SESSION 25-26.xlsx
  { full_name: 'MANSOOR ALI KHAN', job_title: 'A LEVEL FACULTY' },
  { full_name: 'QAMAR HUSSAIN', job_title: 'A LEVEL FACULTY' },
  { full_name: 'ABDUL REHMAN', job_title: 'A LEVEL FACULTY' },
  { full_name: 'NOMAN', job_title: 'A LEVEL FACULTY' },
  { full_name: 'AQEEL AHMED', job_title: 'A LEVEL FACULTY' },
  { full_name: 'ZEESHAN MALIK', job_title: 'A LEVEL FACULTY' },
  { full_name: 'HUSSAIN RAZA', job_title: 'A LEVEL FACULTY' },
  { full_name: 'TAIMOOR SHAHID', job_title: 'A LEVEL FACULTY' },
  { full_name: 'ADEEL', job_title: 'A LEVEL FACULTY' },
  { full_name: 'GHULAM MUSTAFA', job_title: 'A LEVEL FACULTY' },

  // O-Level -- from TEACHERS TIMETABLE OF O LEVEL (2).pdf
  { full_name: 'TABASSUM SIKANDER', job_title: 'O LEVEL FACULTY' },
  { full_name: 'KASHIF KHAN', job_title: 'O LEVEL FACULTY' },
];

async function main() {
  console.log('Backfilling teacher employee_profiles...');
  let created = 0;
  let skipped = 0;

  for (const t of TEACHERS) {
    const existing = await prisma.employee_profiles.findFirst({
      where: { full_name: { equals: t.full_name, mode: 'insensitive' } },
    });
    if (existing) {
      console.log(`  SKIP (already exists, id ${existing.id}): ${t.full_name}`);
      skipped++;
      continue;
    }

    const emp = await prisma.employee_profiles.create({
      data: {
        full_name: t.full_name,
        job_title: t.job_title,
        staff_category_id: TEACHER_CATEGORY_ID,
        department_id: ACADEMICS_DEPARTMENT_ID,
        campus_id: CAMPUS_ID,
        employment_status: 'ACTIVE',
        is_permanent_employee: false,
        check_in_source: 'FIXED',
        notes: 'Name-only placeholder backfilled from timetable schedule sheets; needs full HR onboarding (CNIC, join date, salary, etc).',
      },
    });
    console.log(`  CREATED id ${emp.id}: ${t.full_name} (${t.job_title})`);
    created++;
  }

  console.log(`\nDone. ${created} created, ${skipped} already existed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
