-- AlterTable employee_profiles (family & spouse fields)
ALTER TABLE "employee_profiles" ADD COLUMN IF NOT EXISTS "father_photo_url" TEXT;
ALTER TABLE "employee_profiles" ADD COLUMN IF NOT EXISTS "mother_photo_url" TEXT;
ALTER TABLE "employee_profiles" ADD COLUMN IF NOT EXISTS "spouse_name" VARCHAR(100);
ALTER TABLE "employee_profiles" ADD COLUMN IF NOT EXISTS "spouse_cnic" VARCHAR(50);
ALTER TABLE "employee_profiles" ADD COLUMN IF NOT EXISTS "spouse_photo_url" TEXT;

-- AlterTable staff_categories
ALTER TABLE "staff_categories" ADD COLUMN IF NOT EXISTS "employee_code_dep" VARCHAR(2);

-- Backfill staff_categories with employee_code_dep mapping
UPDATE "staff_categories" SET "employee_code_dep" = '01' WHERE "code" = 'SENIOR_LEADERSHIP';
UPDATE "staff_categories" SET "employee_code_dep" = '02' WHERE "code" IN ('TEACHER', 'ASSISTANT_TEACHER', 'SCOUT_LEADER');
UPDATE "staff_categories" SET "employee_code_dep" = '03' WHERE "code" IN ('ACADEMIC_COORDINATOR', 'ACADEMIC_ADMINISTRATOR', 'ADMINISTRATIVE_STAFF', 'FINANCE_STAFF', 'IT_STAFF', 'CREATIVE_STAFF');
UPDATE "staff_categories" SET "employee_code_dep" = '04' WHERE "code" = 'SUPPORT_STAFF';
UPDATE "staff_categories" SET "employee_code_dep" = '05' WHERE "code" = 'SPORTS_COACH';
UPDATE "staff_categories" SET "employee_code_dep" = '04' WHERE "employee_code_dep" IS NULL;
