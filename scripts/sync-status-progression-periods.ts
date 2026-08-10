import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '=== APPLY MODE ===' : '=== DRY RUN MODE (pass --apply to execute) ===');

  // Find all active (non-deleted) students
  const students = await prisma.students.findMany({
    where: { deleted_at: null },
    select: {
      cc: true,
      full_name: true,
      status: true,
      campus_id: true,
      class_id: true,
      section_id: true,
      house_id: true,
      academic_year: true,
      gr_number: true,
      graduated_from_class_id: true,
    },
  });

  console.log(`Checking ${students.length} students...`);

  let fixCount = 0;

  for (const student of students) {
    // Get latest open progression period (valid_to: null)
    const openPeriod = await prisma.student_progression_periods.findFirst({
      where: { student_cc: student.cc, valid_to: null },
      orderBy: { valid_from: 'desc' },
    });

    if (!openPeriod) continue;

    // Standardize status comparison
    const currentStatus = student.status;
    const periodChangeType = openPeriod.change_type;

    // Check if status is non-enrolled or changed (e.g. LEFT, GRADUATED, EXPELLED)
    if (periodChangeType !== currentStatus) {
      // Avoid mismatch if period is PROMOTED/TRANSFERRED/REASSIGNED/HOUSE_CHANGED while status is ENROLLED
      const activePlacementTypes = ['ENROLLED', 'PROMOTED', 'TRANSFERRED', 'REASSIGNED', 'HOUSE_CHANGED'];
      if (currentStatus === 'ENROLLED' && activePlacementTypes.includes(periodChangeType)) {
        continue;
      }

      // Try to find the exact timestamp of status change from audit_logs or student_flags
      const auditLog = await prisma.audit_logs.findFirst({
        where: {
          student_id: student.cc,
          entity_type: 'STUDENT',
          action: { in: ['STATUS_CHANGED', 'LEFT', 'GRADUATED', 'EXPELLED', 'READMITTED'] },
        },
        orderBy: { changed_at: 'desc' },
      });

      const flag = await prisma.student_flags.findFirst({
        where: {
          student_id: student.cc,
          flag: { contains: '_LOG_' },
        },
        orderBy: { created_at: 'desc' },
      });

      const changeDate = auditLog?.changed_at || flag?.reminder_date || flag?.created_at || new Date();
      const changedBy = auditLog?.changed_by || 'system';

      console.log(
        `CC ${student.cc} (${student.full_name}): Status is "${currentStatus}", but open period is "${periodChangeType}" (since ${openPeriod.valid_from.toISOString().split('T')[0]}). Will fix -> "${currentStatus}" at ${changeDate.toISOString()}`
      );

      fixCount++;

      if (apply) {
        await prisma.$transaction(async (tx) => {
          // Close old period
          await tx.student_progression_periods.update({
            where: { id: openPeriod.id },
            data: { valid_to: changeDate },
          });

          // Create new period for current status
          const effectiveClassId = currentStatus === 'GRADUATED'
            ? (student.class_id ?? student.graduated_from_class_id ?? openPeriod.class_id)
            : (student.class_id ?? openPeriod.class_id);

          await tx.student_progression_periods.create({
            data: {
              student_cc: student.cc,
              campus_id: student.campus_id ?? openPeriod.campus_id,
              class_id: effectiveClassId,
              section_id: student.section_id ?? openPeriod.section_id,
              house_id: student.house_id ?? openPeriod.house_id,
              academic_year: student.academic_year ?? openPeriod.academic_year,
              gr_number: student.gr_number ?? openPeriod.gr_number,
              change_type: currentStatus,
              changed_by: changedBy,
              notes: auditLog?.note || null,
              valid_from: changeDate,
              valid_to: null,
            },
          });
        });
      }
    }
  }

  console.log(`\nFound ${fixCount} student(s) with out-of-sync progression status.`);
  if (!apply && fixCount > 0) {
    console.log('Run with --apply to apply fixes to database.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
