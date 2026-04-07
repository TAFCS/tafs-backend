import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const cc = 7901;
  console.log(`Fetching suggestions for CC #${cc}...`);
  
  const start = Date.now();
  try {
    const student = await prisma.students.findUnique({
      where: { cc },
      select: { campus_id: true, class_id: true, status: true },
    });
    console.log('Student found:', student);
    console.log(`Fetch took ${Date.now() - start}ms`);

    if (student) {
        console.log('Fetching related data...');
        const [gr, house] = await Promise.all([
          prisma.students.findMany({ where: { campus_id: student.campus_id, gr_number: { not: null } }, select: { gr_number: true } }),
          prisma.students.groupBy({
            by: ['house_id'],
            where: { class_id: student.class_id, house_id: { not: null }, status: 'ENROLLED' },
            _count: { _all: true },
          })
        ]);
        console.log(`Related data fetch took ${Date.now() - start}ms total`);
        console.log('House counts:', house);
    }
  } catch (err) {
    console.error('ERROR reaching DB:', err);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
