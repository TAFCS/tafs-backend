import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const cols: any[] = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'students' AND column_name = 'quick_admission_meta'
  `;
  const enums: any[] = await prisma.$queryRaw`
    SELECT enumlabel FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'student_status'
    ORDER BY enumsortorder
  `;
  const maxCc = await prisma.students.aggregate({ _max: { cc: true } });
  const quickCount = await prisma.students.count({
    where: { status: 'QUICK_ADMISSION' as any },
  });
  const uncCount = await prisma.unconfirmed_admissions.count();

  console.log('quick_admission_meta column:', cols);
  console.log('student_status values:', enums.map((e) => e.enumlabel));
  console.log('max students.cc:', maxCc._max.cc);
  console.log('QUICK_ADMISSION students:', quickCount);
  console.log('remaining unconfirmed_admissions:', uncCount);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
