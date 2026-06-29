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

  console.log("Ensuring EMPLOYEE StaffRole value...");
  await prisma.$executeRawUnsafe(`
    ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'EMPLOYEE';
  `);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'StaffRole' AND e.enumlabel = 'EMPLOYEES'
      ) THEN
        ALTER TYPE "StaffRole" RENAME VALUE 'EMPLOYEES' TO 'EMPLOYEE';
      END IF;
    END$$;
  `);

  console.log("Adding staff_category to academic_calendar_days...");
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "academic_calendar_days"
    ADD COLUMN IF NOT EXISTS "staff_category" "StaffCategory";
  `);
  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "academic_calendar_days_campus_id_date_applies_to_key";
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "academic_calendar_days_staff_category_idx"
      ON "academic_calendar_days"("staff_category");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "academic_calendar_days_scope_key"
      ON "academic_calendar_days"(
        "campus_id",
        "date",
        "applies_to",
        "class_id",
        "section_id",
        "department_id",
        "staff_category",
        "employee_id"
      );
  `);

  console.log("Adding employee financial & emergency contact columns...");
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "employee_profiles"
    ADD COLUMN IF NOT EXISTS "account_number" VARCHAR(50),
    ADD COLUMN IF NOT EXISTS "bank_name" VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "emergency_contact_name" VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "emergency_contact_phone" VARCHAR(60),
    ADD COLUMN IF NOT EXISTS "emergency_contact_relationship" VARCHAR(50);
  `);

  console.log("Applying leave management schema...");
  await prisma.$executeRawUnsafe(`
    ALTER TYPE "StaffAttendanceStatus" ADD VALUE IF NOT EXISTS 'UNPAID_LEAVE';
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TYPE "AttendanceSource" ADD VALUE IF NOT EXISTS 'LEAVE';
  `);
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "leave_types" ADD COLUMN IF NOT EXISTS "code" VARCHAR(20);
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "leave_types" SET "code" = 'SICK' WHERE "name" = 'Sick Leave' AND "code" IS NULL;
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "leave_types" SET "code" = 'CASUAL' WHERE "name" = 'Casual Leave' AND "code" IS NULL;
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "leave_types" SET "code" = 'ANNUAL' WHERE "name" = 'Annual Leave' AND "code" IS NULL;
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "leave_types" SET "code" = 'UNPAID' WHERE "name" = 'Unpaid Leave' AND "code" IS NULL;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "leave_types_code_key" ON "leave_types"("code");
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "leave_types" ALTER COLUMN "code" SET NOT NULL;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "employee_profiles"
    ADD COLUMN IF NOT EXISTS "is_permanent_employee" BOOLEAN NOT NULL DEFAULT false;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "leave_requests" (
      "id" SERIAL NOT NULL,
      "employee_id" INTEGER NOT NULL,
      "leave_type_id" INTEGER NOT NULL,
      "start_date" DATE NOT NULL,
      "end_date" DATE NOT NULL,
      "reason" VARCHAR(1000),
      "attachment_url" VARCHAR(500),
      "attachment_type" VARCHAR(20),
      "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
      "reviewed_by" VARCHAR(255),
      "review_reason" VARCHAR(500),
      "reviewed_at" TIMESTAMP(6),
      "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "leave_requests_employee_id_idx" ON "leave_requests"("employee_id");`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "leave_requests_status_idx" ON "leave_requests"("status");`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "leave_requests_start_date_end_date_idx" ON "leave_requests"("start_date", "end_date");`);
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_fkey"
        FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_fkey"
        FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewed_by_fkey"
        FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "teacher_saturday_schedules" (
      "id" SERIAL NOT NULL,
      "employee_id" INTEGER NOT NULL,
      "date" DATE NOT NULL,
      "marked_by" VARCHAR(255) NOT NULL,
      "marked_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "teacher_saturday_schedules_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "teacher_saturday_schedules_employee_id_date_key"
      ON "teacher_saturday_schedules"("employee_id", "date");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "teacher_saturday_schedules_employee_id_date_idx"
      ON "teacher_saturday_schedules"("employee_id", "date");
  `);
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TABLE "teacher_saturday_schedules" ADD CONSTRAINT "teacher_saturday_schedules_employee_id_fkey"
        FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TABLE "teacher_saturday_schedules" ADD CONSTRAINT "teacher_saturday_schedules_marked_by_fkey"
        FOREIGN KEY ("marked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "payroll_run_lines"
    ADD COLUMN IF NOT EXISTS "unpaid_leave_days" INTEGER NOT NULL DEFAULT 0;
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
