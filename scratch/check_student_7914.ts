import { PrismaClient } from '@prisma/client';

async function checkStudent() {
  const prisma = new PrismaClient();
  try {
    const student = await prisma.students.findUnique({
      where: { cc: 7914 },
      include: {
        families: true,
        student_guardians: true,
      }
    });
    console.log('STUDENT DATA:', JSON.stringify(student, null, 2));
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    await prisma.$disconnect();
  }
}

checkStudent();
