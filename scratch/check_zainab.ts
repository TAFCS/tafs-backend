import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const student = await prisma.students.findFirst({
    where: { full_name: { contains: 'ZAINAB' } },
    include: {
      student_admissions: {
        orderBy: { application_date: 'desc' },
        take: 1
      }
    }
  });
  console.log('Student:', JSON.stringify(student, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
