import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '=== APPLY MODE ===' : '=== DRY RUN MODE (pass --apply to execute) ===');

  // Find all progression periods with REASSIGNED change_type that came immediately after a GRADUATED period
  const reassignedPeriods = await prisma.student_progression_periods.findMany({
    where: { change_type: 'REASSIGNED' },
    orderBy: [{ student_cc: 'asc' }, { valid_from: 'asc' }],
    include: {
      students: { select: { cc: true, full_name: true } },
    },
  });

  let fixCount = 0;

  for (const period of reassignedPeriods) {
    // Check if prior period for this student was GRADUATED
    const priorPeriod = await prisma.student_progression_periods.findFirst({
      where: {
        student_cc: period.student_cc,
        valid_from: { lt: period.valid_from },
      },
      orderBy: { valid_from: 'desc' },
    });

    if (priorPeriod && priorPeriod.change_type === 'GRADUATED') {
      fixCount++;
      console.log(
        `Period #${period.id} (CC ${period.student_cc} ${period.students?.full_name ?? ''}): Changing REASSIGNED -> ENROLLED (following GRADUATED period #${priorPeriod.id})`
      );

      if (apply) {
        await prisma.student_progression_periods.update({
          where: { id: period.id },
          data: { change_type: 'ENROLLED' },
        });
      }
    }
  }

  console.log(`\nFound ${fixCount} period(s) to fix.`);
  if (!apply && fixCount > 0) {
    console.log('Run with --apply to commit changes.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
