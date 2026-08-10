/**
 * Seed O-Level subjects from the teacher timetable headers in
 * "timetables/TEACHERS TIMETABLE OF O LEVEL (2).pdf".
 *
 * academic_system is "Cambridge" to match classes.academic_system for
 * O-I/O-II/O-III/SR-I/SR-II/SR-III (no separate "O-Level" value exists there).
 *
 * Run: npx ts-node prisma/seed-subjects-olevel.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ACADEMIC_SYSTEM = 'Cambridge';

const SUBJECTS: Array<{ name: string; code?: string }> = [
  { name: 'ENGLISH' },
  { name: 'URDU' },
  { name: 'ISLAMIYAT' },
  { name: 'PAKISTAN STUDIES' },
  { name: 'MATHEMATICS' },
  { name: 'PHYSICS' },
  { name: 'CHEMISTRY' },
  { name: 'BIOLOGY' },
  { name: 'COMPUTER SCIENCE' },
  { name: 'ACCOUNTING' },
  { name: 'BUSINESS STUDIES' },
  { name: 'ECONOMICS' },
];

async function main() {
  console.log('Seeding O-Level subjects...');
  let upserted = 0;

  for (const s of SUBJECTS) {
    await prisma.subjects.upsert({
      where: {
        name_academic_system: {
          name: s.name,
          academic_system: ACADEMIC_SYSTEM,
        },
      },
      update: {
        code: s.code ?? null,
        is_active: true,
      },
      create: {
        name: s.name,
        code: s.code ?? null,
        academic_system: ACADEMIC_SYSTEM,
        is_active: true,
      },
    });
    upserted++;
  }

  console.log(`Done. Upserted ${upserted} subjects for ${ACADEMIC_SYSTEM}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
