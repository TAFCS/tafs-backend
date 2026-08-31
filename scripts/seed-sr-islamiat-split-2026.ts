/**
 * seed-sr-islamiat-split-2026.ts
 *
 * Islamiat Sr I is split by section in the allocation list:
 *   - Uzma Mateen  → Sr I section A  (IA)
 *   - Bushra Ijaz  → Sr I sections B & C (IB & IC)
 *
 * HR Class & Sections cannot express subject+section splits, so this lives in
 * teaching_groups + student_subject_enrollments (+ group timetables for slots).
 *
 * Usage:
 *   npx ts-node scripts/seed-sr-islamiat-split-2026.ts
 *   DRY_RUN=false npx ts-node scripts/seed-sr-islamiat-split-2026.ts
 */

import { PrismaClient } from '@prisma/client';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const prisma = new PrismaClient();

const CAMPUS_ID = 1; // Gulistan-e-Johar
const ACADEMIC_YEAR = '2026-2027';
const SRI_CLASS_ID = 9;

const BUSHRA_CODE_SUFFIX = '02-001348';
const UZMA_CODE_SUFFIX = '02-001502';

const ISLAMIYAT_SUBJECT_NAME = 'ISLAMIYAT';
const CAMBRIDGE = 'Cambridge';

type SplitSpec = {
  employeeCodeSuffix: string;
  label: string;
  sectionIds: number[];
};

const SPLITS: SplitSpec[] = [
  { employeeCodeSuffix: UZMA_CODE_SUFFIX, label: 'Sr I A — Islamiat', sectionIds: [1] },
  { employeeCodeSuffix: BUSHRA_CODE_SUFFIX, label: 'Sr I B & C — Islamiat', sectionIds: [2, 3] },
];

async function findEmployeeByCodeSuffix(codeSuffix: string) {
  const suffix = codeSuffix.trim().toUpperCase();
  const candidates = await prisma.employee_profiles.findMany({
    where: {
      OR: [
        { employee_code: suffix },
        { employee_code: { endsWith: suffix } },
        { employee_code: { endsWith: `-${suffix}` } },
      ],
    },
    select: { id: true, employee_code: true, full_name: true },
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return (
      candidates.find((c) => c.employee_code?.toUpperCase() === suffix) ??
      candidates.find((c) => c.employee_code?.toUpperCase().endsWith(suffix)) ??
      null
    );
  }
  return null;
}

async function enrolledStudentIds(classId: number, sectionIds: number[]): Promise<number[]> {
  const rows = await prisma.students.findMany({
    where: {
      campus_id: CAMPUS_ID,
      class_id: classId,
      section_id: { in: sectionIds },
      status: 'ENROLLED',
      deleted_at: null,
    },
    select: { cc: true },
    orderBy: { cc: 'asc' },
  });
  return rows.map((r) => r.cc);
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN (no writes) ===\n' : '=== APPLYING SR I ISLAMIYAT SPLIT ===\n');

  const subject = await prisma.subjects.findFirst({
    where: { name: ISLAMIYAT_SUBJECT_NAME, academic_system: CAMBRIDGE, is_active: true },
    select: { id: true, name: true },
  });
  if (!subject) {
    throw new Error(`Subject "${ISLAMIYAT_SUBJECT_NAME}" (${CAMBRIDGE}) not found`);
  }

  const campusClass = await prisma.campus_classes.findFirst({
    where: { campus_id: CAMPUS_ID, class_id: SRI_CLASS_ID },
  });
  if (!campusClass) {
    throw new Error(`Class SRI (#${SRI_CLASS_ID}) not offered at campus #${CAMPUS_ID}`);
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const spec of SPLITS) {
    const employee = await findEmployeeByCodeSuffix(spec.employeeCodeSuffix);
    if (!employee) {
      throw new Error(`Employee not found for suffix ${spec.employeeCodeSuffix}`);
    }

    const studentIds = await enrolledStudentIds(SRI_CLASS_ID, spec.sectionIds);
    console.log(
      `\n${employee.full_name} (${employee.employee_code}) — ${spec.label} — ${studentIds.length} student(s)`,
    );

    if (DRY_RUN) {
      console.log(`  [DRY] would upsert teaching_group + enroll ${studentIds.length} + timetable`);
      continue;
    }

    const group = await prisma.teaching_groups.upsert({
      where: {
        campus_id_class_id_subject_id_employee_id_academic_year: {
          campus_id: CAMPUS_ID,
          class_id: SRI_CLASS_ID,
          subject_id: subject.id,
          employee_id: employee.id,
          academic_year: ACADEMIC_YEAR,
        },
      },
      update: { label: spec.label, is_active: true },
      create: {
        campus_id: CAMPUS_ID,
        class_id: SRI_CLASS_ID,
        subject_id: subject.id,
        employee_id: employee.id,
        academic_year: ACADEMIC_YEAR,
        label: spec.label,
      },
      select: { id: true, label: true },
    });

    await prisma.student_subject_enrollments.deleteMany({
      where: { teaching_group_id: group.id, academic_year: ACADEMIC_YEAR },
    });

    if (studentIds.length > 0) {
      await prisma.student_subject_enrollments.createMany({
        data: studentIds.map((studentId) => ({
          student_id: studentId,
          teaching_group_id: group.id,
          academic_year: ACADEMIC_YEAR,
        })),
      });
    }

    await prisma.timetables.upsert({
      where: {
        campus_id_teaching_group_id_academic_year: {
          campus_id: CAMPUS_ID,
          teaching_group_id: group.id,
          academic_year: ACADEMIC_YEAR,
        },
      },
      update: { is_active: true },
      create: {
        campus_id: CAMPUS_ID,
        class_id: SRI_CLASS_ID,
        teaching_group_id: group.id,
        academic_year: ACADEMIC_YEAR,
        effective_from: today,
        is_active: true,
        created_by: 'seed-sr-islamiat-split-2026',
      },
    });

    console.log(`  [OK] teaching_group #${group.id} — ${studentIds.length} enrolled, timetable ready`);
  }

  if (DRY_RUN) {
    console.log('\nRun with DRY_RUN=false to apply.');
  } else {
    console.log('\nDone. Assign Islamiat slots in HR → Timetables → teaching group grid when schedule is known.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
