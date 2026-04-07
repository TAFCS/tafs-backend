import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.students.findMany({
    where: {
      status: 'SOFT_ADMISSION',
      deleted_at: null,
    },
    select: {
        cc: true,
        full_name: true,
        status: true
    }
  });
  console.log('Soft Admission Candidates:', JSON.stringify(candidates, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
