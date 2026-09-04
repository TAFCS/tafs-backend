/**
 * One-off backfill: open a baseline ONBOARDED employment period for every
 * employee that has no employee_progression_periods yet, snapshotting their
 * current campus / segment / department / staff category / pay / status and
 * class-section assignments. Idempotent — re-running writes nothing new.
 *
 * Usage:
 *   DRY_RUN=true npx ts-node scripts/backfill-employee-progression-periods.ts
 *   npx ts-node scripts/backfill-employee-progression-periods.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  console.log(dryRun ? '--- DRY RUN MODE ---' : '--- EXECUTION MODE ---');

  const employees = await prisma.employee_profiles.findMany({
    select: {
      id: true,
      join_date: true,
      campus_id: true,
      segment_id: true,
      department_id: true,
      staff_category_id: true,
      reporting_manager_id: true,
      job_title: true,
      employment_type: true,
      employment_status: true,
      monthly_pay: true,
      payroll_enabled: true,
      employee_class_section_assignments: {
        select: { class_id: true, section_id: true },
      },
    },
    orderBy: { id: 'asc' },
  });

  console.log(`Found ${employees.length} employees.`);

  let written = 0;
  let skipped = 0;

  for (const emp of employees) {
    const existing = await prisma.employee_progression_periods.count({
      where: { employee_id: emp.id },
    });
    if (existing > 0) {
      skipped++;
      continue;
    }

    if (!dryRun) {
      await prisma.employee_progression_periods.create({
        data: {
          employee_id: emp.id,
          campus_id: emp.campus_id,
          segment_id: emp.segment_id,
          department_id: emp.department_id,
          staff_category_id: emp.staff_category_id,
          reporting_manager_id: emp.reporting_manager_id,
          job_title: emp.job_title,
          employment_type: emp.employment_type,
          employment_status: emp.employment_status,
          monthly_pay: emp.monthly_pay,
          payroll_enabled: emp.payroll_enabled,
          class_sections: emp.employee_class_section_assignments.map((a) => ({
            class_id: a.class_id,
            section_id: a.section_id,
          })),
          change_type: 'ONBOARDED',
          changed_by: 'system',
          valid_from: emp.join_date ?? new Date(),
          valid_to: null,
        },
      });
    }
    written++;
  }

  console.log('--- Summary ---');
  console.log(`Baseline periods written:  ${written}`);
  console.log(`Skipped (already filled):  ${skipped}`);
  if (dryRun) console.log('No rows were written (dry run).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
