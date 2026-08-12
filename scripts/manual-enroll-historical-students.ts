/**
 * One-off manual enrollment for two returning students with no prior digital
 * record (CC 7060, 7061 — pre-dates this system). Not a reinstatement, since
 * there is no existing row to restore: this creates fresh ENROLLED records
 * with the explicit legacy CC numbers, opens their first progression period,
 * and logs the action so it is distinguishable from a normal new admission.
 *
 * Run once: npx ts-node scripts/manual-enroll-historical-students.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ACTOR = 'manual-data-entry';
const ACADEMIC_YEAR = '2026-2027';
const DOA = new Date('2026-08-12');

type Input = {
  cc: number;
  full_name: string;
  gr_number: string;
  classCode: string;
  sectionDescription: string | null;
  campus_id: number;
};

const STUDENTS: Input[] = [
  {
    cc: 7060,
    full_name: 'MUHAMMAD ABUBAKAR',
    gr_number: 'A5832',
    classCode: 'JRII', // JR2
    sectionDescription: null,
    campus_id: 1,
  },
  {
    cc: 7061,
    full_name: 'CHAUDHRY MUHAMMAD',
    gr_number: 'A5833',
    classCode: 'JRIV', // JR4
    sectionDescription: 'B',
    campus_id: 1,
  },
];

async function main() {
  for (const input of STUDENTS) {
    const existing = await prisma.students.findUnique({ where: { cc: input.cc } });
    if (existing) {
      throw new Error(`CC ${input.cc} already exists — refusing to overwrite. Aborting before any writes.`);
    }

    const grClash = await prisma.students.findFirst({
      where: { campus_id: input.campus_id, gr_number: input.gr_number, deleted_at: null },
    });
    if (grClash) {
      throw new Error(`GR ${input.gr_number} already assigned to CC ${grClash.cc} at campus ${input.campus_id}. Aborting.`);
    }

    const cls = await prisma.classes.findFirst({ where: { class_code: input.classCode } });
    if (!cls) throw new Error(`Class code ${input.classCode} not found`);

    let sectionId: number | null = null;
    if (input.sectionDescription) {
      const section = await prisma.sections.findFirst({ where: { description: input.sectionDescription } });
      if (!section) throw new Error(`Section ${input.sectionDescription} not found`);
      sectionId = section.id;
    }

    await prisma.$transaction(async (tx) => {
      const created = await tx.students.create({
        data: {
          cc: input.cc,
          full_name: input.full_name,
          gr_number: input.gr_number,
          status: 'ENROLLED',
          campus_id: input.campus_id,
          class_id: cls.id,
          section_id: sectionId,
          academic_year: ACADEMIC_YEAR,
          doa: DOA,
        },
      });

      await tx.student_progression_periods.create({
        data: {
          student_cc: created.cc,
          campus_id: created.campus_id,
          class_id: created.class_id,
          section_id: created.section_id,
          house_id: created.house_id,
          academic_year: created.academic_year,
          gr_number: created.gr_number,
          change_type: 'ENROLLED',
          changed_by: ACTOR,
          notes: 'Manually enrolled — returning historical student, no prior digital record in this system.',
          valid_from: new Date(),
          valid_to: null,
        },
      });

      await tx.student_flags.create({
        data: {
          student_id: created.cc,
          flag: `MANUAL_HISTORICAL_ENROLLMENT_${Date.now()}`,
          reminder_date: new Date(),
          work_done: true,
          comment: 'Manually enrolled by staff as a returning student pre-dating digital records (no LEFT/EXPELLED row existed to reinstate).',
        },
      });

      await tx.audit_logs.create({
        data: {
          entity_type: 'STUDENT',
          entity_id: String(created.cc),
          action: 'MANUAL_HISTORICAL_ENROLLMENT',
          section: 'student',
          new_value: 'ENROLLED',
          changed_by: ACTOR,
          student_id: created.cc,
          changed_at: new Date(),
          note: `${created.full_name} (CC ${created.cc}, GR ${created.gr_number}) manually enrolled as a returning historical student — no prior digital record existed for this CC.`,
        },
      });

      console.log(`Created CC ${created.cc} — ${created.full_name} (GR ${created.gr_number}, class ${cls.description}, section ${input.sectionDescription ?? '—'})`);
    });
  }
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
