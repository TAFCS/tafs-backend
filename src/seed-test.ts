import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting test data seeding...');

  // 1. Upsert Class 14
  const testClass = await prisma.classes.upsert({
    where: { id: 14 },
    update: {},
    create: {
      id: 14,
      description: 'Test Class 14',
      class_code: 'TC14',
      academic_system: 'MATRIC',
    },
  });
  console.log('Class 14:', testClass);

  // 2. Upsert Section 1
  const testSection = await prisma.sections.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      description: 'Test Section 1',
    },
  });
  console.log('Section 1:', testSection);

  // 3. Upsert Campus Class Mapping
  const campusClass = await prisma.campus_classes.upsert({
    where: { campus_id_class_id: { campus_id: 2, class_id: 14 } },
    update: {},
    create: {
      campus_id: 2,
      class_id: 14,
    },
  });
  console.log('Campus Class Mapping:', campusClass);

  // 4. Upsert Campus Section Mapping
  const campusSection = await prisma.campus_sections.upsert({
    where: { campus_id_class_id_section_id: { campus_id: 2, class_id: 14, section_id: 1 } },
    update: {},
    create: {
      campus_id: 2,
      class_id: 14,
      section_id: 1,
    },
  });
  console.log('Campus Section Mapping:', campusSection);

  // 5. Move students with cc 1 and 2
  const updateS1 = await prisma.students.updateMany({
    where: { cc: 1 },
    data: {
      campus_id: 2,
      class_id: 14,
      section_id: 1,
    },
  });
  console.log('Updated student cc=1 count:', updateS1.count);

  const updateS2 = await prisma.students.updateMany({
    where: { cc: 2 },
    data: {
      campus_id: 2,
      class_id: 14,
      section_id: 1,
    },
  });
  console.log('Updated student cc=2 count:', updateS2.count);

  // 6. Add class-wise fee schedule
  // Delete existing to prevent duplicates
  await prisma.class_fee_schedule.deleteMany({
    where: {
      class_id: 14,
      fee_id: 1,
    },
  });

  const feeSchedule = await prisma.class_fee_schedule.create({
    data: {
      class_id: 14,
      fee_id: 1,
      amount: 10000,
    },
  });
  console.log('Created Fee Schedule:', feeSchedule);
}

main()
  .catch((e) => {
    console.error('Error seeding test data:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
