-- Replace StaffCategory enum with department-scoped staff_categories table

-- Ensure SUPPORT SERVICES department exists for SUPPORT_STAFF mapping
INSERT INTO "departments" ("name", "description")
SELECT 'SUPPORT SERVICES', 'Facility and domestic staff: peons, guards, drivers, aya, gardener, electrician, plumber, carpenter'
WHERE NOT EXISTS (
  SELECT 1 FROM "departments" WHERE "name" = 'SUPPORT SERVICES'
);

CREATE TABLE "staff_categories" (
    "id" SERIAL NOT NULL,
    "department_id" INTEGER NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    CONSTRAINT "staff_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_categories_department_id_code_key" ON "staff_categories"("department_id", "code");
CREATE UNIQUE INDEX "staff_categories_department_id_name_key" ON "staff_categories"("department_id", "name");
CREATE INDEX "staff_categories_department_id_idx" ON "staff_categories"("department_id");

ALTER TABLE "staff_categories"
  ADD CONSTRAINT "staff_categories_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed categories from former enum values, mapped to departments
INSERT INTO "staff_categories" ("department_id", "code", "name", "description")
SELECT d.id, v.code, v.name, v.description
FROM (VALUES
  ('ACADEMICS', 'TEACHER', 'TEACHER', 'Subject teachers and class/home-room teachers'),
  ('ACADEMICS', 'ASSISTANT_TEACHER', 'ASSISTANT TEACHER', 'Co-teachers and helper teachers'),
  ('ACADEMICS', 'SPORTS_COACH', 'SPORTS COACH', 'Taekwondo, gymnastics, and specialized activity coaches'),
  ('ACADEMICS', 'SCOUT_LEADER', 'SCOUT LEADER', 'Scout leaders'),
  ('ACADEMICS', 'ACADEMIC_COORDINATOR', 'ACADEMIC COORDINATOR', 'Coordinators, subject heads, academic assistants, deputy segment heads'),
  ('ACADEMICS', 'ACADEMIC_ADMINISTRATOR', 'ACADEMIC ADMINISTRATOR', 'Headmistress, principal, campus directress, sports manager, A-level manager'),
  ('SENIOR MANAGEMENT', 'SENIOR_LEADERSHIP', 'SENIOR LEADERSHIP', 'CEO, MD, group directresses, deputy directress'),
  ('ADMINISTRATION', 'ADMINISTRATIVE_STAFF', 'ADMINISTRATIVE STAFF', 'Office assistants, FDOs, admin assistants'),
  ('IT & TECHNOLOGY', 'IT_STAFF', 'IT STAFF', 'IT manager and computer operators'),
  ('IT & TECHNOLOGY', 'CREATIVE_STAFF', 'CREATIVE STAFF', 'Graphic designers'),
  ('FINANCE', 'FINANCE_STAFF', 'FINANCE STAFF', 'Finance directress and accounts staff'),
  ('SUPPORT SERVICES', 'SUPPORT_STAFF', 'SUPPORT STAFF', 'Facility and domestic staff')
) AS v(dept_name, code, name, description)
JOIN "departments" d ON d.name = v.dept_name;

-- Add new FK columns
ALTER TABLE "employee_profiles" ADD COLUMN "staff_category_id" INTEGER;
ALTER TABLE "academic_calendar_days" ADD COLUMN "staff_category_id" INTEGER;

-- Backfill employees from enum → category id (match by code)
UPDATE "employee_profiles" ep
SET "staff_category_id" = sc.id
FROM "staff_categories" sc
WHERE ep."staff_category"::text = sc.code;

-- Also align department_id when missing but category is set
UPDATE "employee_profiles" ep
SET "department_id" = sc.department_id
FROM "staff_categories" sc
WHERE ep."staff_category_id" = sc.id
  AND (ep."department_id" IS NULL OR ep."department_id" <> sc.department_id);

-- Backfill calendar rows
UPDATE "academic_calendar_days" acd
SET "staff_category_id" = sc.id
FROM "staff_categories" sc
WHERE acd."staff_category"::text = sc.code;

UPDATE "academic_calendar_days" acd
SET "department_id" = sc.department_id
FROM "staff_categories" sc
WHERE acd."staff_category_id" = sc.id
  AND (acd."department_id" IS NULL OR acd."department_id" <> sc.department_id);

-- Drop old unique + enum index before dropping enum columns
DROP INDEX IF EXISTS "academic_calendar_days_scope_key";
DROP INDEX IF EXISTS "academic_calendar_days_staff_category_idx";

ALTER TABLE "employee_profiles" DROP COLUMN IF EXISTS "staff_category";
ALTER TABLE "academic_calendar_days" DROP COLUMN IF EXISTS "staff_category";

ALTER TABLE "employee_profiles"
  ADD CONSTRAINT "employee_profiles_staff_category_id_fkey"
  FOREIGN KEY ("staff_category_id") REFERENCES "staff_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "academic_calendar_days"
  ADD CONSTRAINT "academic_calendar_days_staff_category_id_fkey"
  FOREIGN KEY ("staff_category_id") REFERENCES "staff_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "academic_calendar_days_scope_key"
  ON "academic_calendar_days"(
    "campus_id",
    "date",
    "applies_to",
    "class_id",
    "section_id",
    "department_id",
    "staff_category_id",
    "employee_id"
  );

CREATE INDEX "academic_calendar_days_staff_category_id_idx"
  ON "academic_calendar_days"("staff_category_id");

DROP TYPE IF EXISTS "StaffCategory";
