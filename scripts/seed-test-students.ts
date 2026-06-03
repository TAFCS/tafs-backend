/**
 * seed-test-students.ts
 *
 * One-time test data setup:
 *
 * Family A  (household_name = "aawaiz", no email/password)
 *   ├─ CC=2  TEST STUDENT B  — moved from old family
 *   └─ CC=3  TEST STUDENT C  — new, campus 2, class 15, section 1
 *   Father guardian: aawaiz  CNIC=42201-6236114-7  → linked to CC=2 and CC=3
 *
 * Family B  (household_name = "hashir", no email/password)
 *   └─ CC=4  TEST STUDENT D  — new, campus 2, class 15, section 1
 *   Father guardian: hashir  CNIC=42101-7181319-5  → linked to CC=4
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('═══ TEST STUDENT SEED ═══\n');

  // ── Family A ──────────────────────────────────────────────────────────────
  const familyA = await prisma.families.create({
    data: { household_name: 'aawaiz', email: null, password_hash: null },
  });
  console.log(`Created Family A  id=${familyA.id}  household="aawaiz"`);

  // Move CC=2 to Family A
  await prisma.students.update({
    where: { cc: 2 },
    data: { family_id: familyA.id },
  });
  console.log(`  CC=2 TEST STUDENT B  → family_id=${familyA.id}`);

  // Create CC=3 TEST STUDENT C
  await prisma.students.create({
    data: {
      cc:         3,
      full_name:  'TEST STUDENT C',
      status:     'ENROLLED',
      campus_id:  2,
      class_id:   15,
      section_id: 1,
      family_id:  familyA.id,
    },
  });
  console.log(`  CC=3 TEST STUDENT C  → campus=2 class=15 section=1 family_id=${familyA.id}`);

  // Guardian Aawaiz → link to CC=2 and CC=3
  const guardianAawaiz = await prisma.guardians.upsert({
    where:  { cnic: '42201-6236114-7' },
    create: { cnic: '42201-6236114-7', full_name: 'aawaiz' },
    update: { full_name: 'aawaiz' },
  });
  console.log(`  Guardian aawaiz  id=${guardianAawaiz.id}  CNIC=42201-6236114-7`);

  await prisma.student_guardians.createMany({
    data: [
      { student_id: 2, guardian_id: guardianAawaiz.id, relationship: 'Father', is_primary_contact: true, is_emergency_contact: true },
      { student_id: 3, guardian_id: guardianAawaiz.id, relationship: 'Father', is_primary_contact: true, is_emergency_contact: true },
    ],
    skipDuplicates: true,
  });
  console.log(`  Linked aawaiz as Father to CC=2 and CC=3`);

  // ── Family B ──────────────────────────────────────────────────────────────
  const familyB = await prisma.families.create({
    data: { household_name: 'hashir', email: null, password_hash: null },
  });
  console.log(`\nCreated Family B  id=${familyB.id}  household="hashir"`);

  // Create CC=4 TEST STUDENT D
  await prisma.students.create({
    data: {
      cc:         4,
      full_name:  'TEST STUDENT D',
      status:     'ENROLLED',
      campus_id:  2,
      class_id:   15,
      section_id: 1,
      family_id:  familyB.id,
    },
  });
  console.log(`  CC=4 TEST STUDENT D  → campus=2 class=15 section=1 family_id=${familyB.id}`);

  // Guardian Hashir → link to CC=4
  const guardianHashir = await prisma.guardians.upsert({
    where:  { cnic: '42101-7181319-5' },
    create: { cnic: '42101-7181319-5', full_name: 'hashir' },
    update: { full_name: 'hashir' },
  });
  console.log(`  Guardian hashir  id=${guardianHashir.id}  CNIC=42101-7181319-5`);

  await prisma.student_guardians.create({
    data: { student_id: 4, guardian_id: guardianHashir.id, relationship: 'Father', is_primary_contact: true, is_emergency_contact: true },
  });
  console.log(`  Linked hashir as Father to CC=4`);

  console.log('\n══ DONE ══');
}

main()
  .catch((e) => { console.error('Fatal:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
