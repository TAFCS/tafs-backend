import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '=== APPLY MODE ===' : '=== DRY RUN MODE (pass --apply to execute) ===');

  // Find all progression periods with GRADUATED change_type and null class_id
  const periods = await prisma.student_progression_periods.findMany({
    where: {
      change_type: 'GRADUATED',
      class_id: null,
    },
    include: {
      students: {
        select: {
          cc: true,
          full_name: true,
          graduated_from_class_id: true,
          class_id: true,
        },
      },
    },
  });

  console.log(`Found ${periods.length} GRADUATED progression period(s) with null class_id.`);

  let updatedCount = 0;

  for (const period of periods) {
    let resolvedClassId = period.students?.graduated_from_class_id ?? null;

    if (!resolvedClassId) {
      // Look up student_academic_history for the last known class_id before graduation
      const lastHistory = await prisma.student_academic_history.findFirst({
        where: {
          student_cc: period.student_cc,
          class_id: { not: null },
        },
        orderBy: { changed_at: 'desc' },
      });
      if (lastHistory?.class_id) {
        resolvedClassId = lastHistory.class_id;
      }
    }

    if (!resolvedClassId) {
      // Look up adjacent progression period for this student with non-null class_id
      const adjacentPeriod = await prisma.student_progression_periods.findFirst({
        where: {
          student_cc: period.student_cc,
          class_id: { not: null },
        },
        orderBy: { valid_from: 'asc' },
      });
      if (adjacentPeriod?.class_id) {
        resolvedClassId = adjacentPeriod.class_id;
      }
    }

    if (resolvedClassId) {
      updatedCount++;
      const classNameRow = await prisma.classes.findUnique({
        where: { id: resolvedClassId },
        select: { description: true },
      });

      console.log(
        `Period #${period.id} (CC ${period.student_cc} ${period.students?.full_name ?? ''}): Setting class_id = ${resolvedClassId} (${classNameRow?.description ?? '—'})`
      );

      if (apply) {
        await prisma.student_progression_periods.update({
          where: { id: period.id },
          data: { class_id: resolvedClassId },
        });
      }
    } else {
      console.log(`Period #${period.id} (CC ${period.student_cc}): Could not resolve graduated class_id.`);
    }
  }

  console.log(`\nUpdated ${updatedCount} period(s).`);
  if (!apply && updatedCount > 0) {
    console.log('Run with --apply to commit changes.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
