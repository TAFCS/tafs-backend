/**
 * migrate-and-clean-data.ts
 *
 * Re-applies staff org mapping (role, staff_category_id, department) to all
 * existing employee_profiles using staff-org-mapping.ts rules.
 *
 * Usage: npx ts-node scripts/migrate-and-clean-data.ts
 */

import { PrismaClient } from '@prisma/client';
import { DEPARTMENT_SEED, resolveStaffOrg } from './staff-org-mapping';

const prisma = new PrismaClient();

async function main() {
  for (const dept of DEPARTMENT_SEED) {
    const existing = await prisma.departments.findFirst({ where: { name: dept.name } });
    if (existing) {
      await prisma.departments.update({
        where: { id: existing.id },
        data: { description: dept.description },
      });
    } else {
      await prisma.departments.create({ data: { name: dept.name, description: dept.description } });
    }
  }

  const departmentIdByName = new Map(
    (await prisma.departments.findMany()).map((d) => [d.name, d.id]),
  );

  const categoryIdByCode = new Map(
    (await prisma.staff_categories.findMany()).map((c) => [c.code, c.id]),
  );

  const employees = await prisma.employee_profiles.findMany({
    select: {
      id: true,
      employee_code: true,
      full_name: true,
      job_title: true,
      designations: { select: { title: true } },
    },
  });

  console.log(`Processing ${employees.length} employees...`);
  let updatedCount = 0;

  for (const emp of employees) {
    const rawTitle = emp.job_title;
    const designation = emp.designations?.title ?? null;
    const { role, staffCategory, departmentName } = resolveStaffOrg(
      rawTitle,
      designation,
      emp.employee_code,
    );

    await prisma.employee_profiles.update({
      where: { id: emp.id },
      data: {
        job_title: role,
        staff_category_id: staffCategory ? categoryIdByCode.get(staffCategory) ?? null : null,
        department_id: departmentName ? departmentIdByName.get(departmentName) ?? null : null,
      },
    });

    console.log(
      `[${emp.employee_code}] ${emp.full_name}: role="${role}" category="${staffCategory}" dept="${departmentName}"`,
    );
    updatedCount++;
  }

  console.log(`\nMigration completed! Updated ${updatedCount} profiles.`);
}

main()
  .catch((e) => {
    console.error('Data migration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
