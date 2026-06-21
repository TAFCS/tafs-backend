const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("Applying DDL migration to DigitalOcean PostgreSQL database...");

  // 1. Create the enum type if it does not exist
  const typeExists = await prisma.$queryRaw`
    SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TeacherCategory');
  `;
  const exists = typeExists[0]?.exists;
  
  if (!exists) {
    console.log("Creating enum type 'TeacherCategory'...");
    await prisma.$executeRawUnsafe(`
      CREATE TYPE "TeacherCategory" AS ENUM (
        'HOMEROOM_PRE_PRIMARY',
        'LANGUAGES',
        'MATHEMATICS',
        'SCIENCES',
        'HUMANITIES_SOCIAL_SCIENCES',
        'ARTS_CO_CURRICULAR',
        'SPORTS_PHYSICAL_EDUCATION',
        'IT_COMPUTERS',
        'ADMIN_SUPPORT',
        'MANAGEMENT',
        'DOMESTIC_STAFF'
      );
    `);
    console.log("Enum type 'TeacherCategory' created successfully.");
  } else {
    console.log("Enum type 'TeacherCategory' already exists.");
  }

  // 2. Add column teacher_category if it does not exist
  console.log("Adding column 'teacher_category' to 'employee_profiles' if it doesn't exist...");
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "employee_profiles" 
    ADD COLUMN IF NOT EXISTS "teacher_category" "TeacherCategory";
  `);
  console.log("Column 'teacher_category' verified/added successfully.");
}

main()
  .catch(e => {
    console.error("DDL Migration failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
