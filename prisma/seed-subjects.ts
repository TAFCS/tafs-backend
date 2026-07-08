/**
 * Seed A-Level subjects from the Cambridge subject lists used in admissions
 * registration (GROUP A + GROUP B, deduped by name).
 *
 * Run: npx ts-node prisma/seed-subjects.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ACADEMIC_SYSTEM = 'A-Level';

/** Deduped from A_LEVEL_SUBJECTS_GROUP_A / _GROUP_B in registration-form.tsx */
const SUBJECTS: Array<{ name: string; code: string }> = [
  { name: 'BIOLOGY', code: '9700' },
  { name: 'CHEMISTRY', code: '9701' },
  { name: 'PHYSICS', code: '9702' },
  { name: 'MATHEMATICS', code: '9709' },
  { name: 'URDU', code: '9686' },
  { name: 'COMPUTER SCIENCE', code: '9618' },
  { name: 'SOCIOLOGY', code: '9699' },
  { name: 'ACCOUNTING', code: '9706' },
  { name: 'BUSINESS', code: '9707' },
  { name: 'ECONOMICS', code: '9708' },
];

async function main() {
  console.log('Seeding subjects...');
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
        code: s.code,
        is_active: true,
      },
      create: {
        name: s.name,
        code: s.code,
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
