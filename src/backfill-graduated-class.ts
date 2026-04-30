import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.students.updateMany({
    where: {
      status: 'GRADUATED',
      graduated_from_class_id: null,
    },
    data: {
      graduated_from_class_id: 19,
    },
  });
  console.log(`Backfilled ${result.count} graduated students with graduated_from_class_id = 19`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
