import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const campuses = await prisma.campuses.findMany();
  console.log('--- Campuses ---');
  console.log(campuses);
}

main().catch(console.error).finally(() => prisma.$disconnect());
