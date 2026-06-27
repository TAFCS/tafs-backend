const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("Applying DDL migration to PostgreSQL database...");

  const typeExists = await prisma.$queryRaw`
    SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StaffCategory');
  `;
  const exists = typeExists[0]?.exists;

  if (!exists) {
    console.log("Creating enum type 'StaffCategory'...");
    await prisma.$executeRawUnsafe(`
      CREATE TYPE "StaffCategory" AS ENUM (
        'TEACHER',
        'ASSISTANT_TEACHER',
        'SPORTS_COACH',
        'SCOUT_LEADER',
        'ACADEMIC_COORDINATOR',
        'ACADEMIC_ADMINISTRATOR',
        'SENIOR_LEADERSHIP',
        'ADMINISTRATIVE_STAFF',
        'IT_STAFF',
        'CREATIVE_STAFF',
        'FINANCE_STAFF'
      );
    `);
    console.log("Enum type 'StaffCategory' created successfully.");
  } else {
    console.log("Enum type 'StaffCategory' already exists.");
  }

  console.log("Migrating employee_profiles category column...");
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "employee_profiles" DROP COLUMN IF EXISTS "teacher_category";
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "employee_profiles"
    ADD COLUMN IF NOT EXISTS "staff_category" "StaffCategory";
  `);
  await prisma.$executeRawUnsafe(`
    DROP TYPE IF EXISTS "TeacherCategory";
  `);

  console.log("Adding EMPLOYEES to StaffRole if missing...");
  await prisma.$executeRawUnsafe(`
    ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'EMPLOYEES';
  `);

  console.log("DDL migration completed successfully.");
}

main()
  .catch(e => {
    console.error("DDL Migration failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
