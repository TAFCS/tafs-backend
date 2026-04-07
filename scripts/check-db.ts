import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const houses = await prisma.houses.findMany();
  console.log('Houses:', JSON.stringify(houses, null, 2));

  const totalStudents = await prisma.students.count();
  console.log('Total students:', totalStudents);

  const studentsWithStatus = await prisma.students.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  console.log('Student status breakdown:', JSON.stringify(studentsWithStatus, null, 2));

  const maxGrNumbersPerCampus = await prisma.students.groupBy({
    by: ['campus_id'],
    _max: { gr_number: true },
  });
  console.log('Max GR numbers per campus:', JSON.stringify(maxGrNumbersPerCampus, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
