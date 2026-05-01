import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const classes = await prisma.classes.findMany({
    select: { description: true, academic_system: true }
  });
  console.log(JSON.stringify(classes, null, 2));
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
