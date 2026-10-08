-- TAFSD-275 step 3.
-- 1. FAMILY is retired as a kind of employment: family staff are PERMANENT.
-- 2. Step 1's backfill put everyone who was ACTIVE/PERMANENT on NON_PERMANENT
--    without reading is_permanent_employee (set by the 14-month rule in
--    PermanentEmployeeScheduler). Those employees are permanent.
-- 3. Drop the enum values no row uses any more: EmployeeStatus PERMANENT /
--    FAMILY (collapsed into ACTIVE in step 1) and EmploymentSubtype FAMILY.
-- employee_progression_periods.employment_status is VARCHAR history and is
-- left as recorded.

BEGIN;

UPDATE "employee_profiles"
SET "employment_status" = 'ACTIVE', "employment_subtype" = 'PERMANENT', "is_permanent_employee" = true
WHERE "employment_status" IN ('PERMANENT', 'FAMILY');

UPDATE "employee_profiles"
SET "employment_subtype" = 'PERMANENT', "is_permanent_employee" = true
WHERE "employment_subtype" = 'FAMILY';

UPDATE "employee_profiles"
SET "employment_subtype" = 'PERMANENT'
WHERE "employment_status" = 'ACTIVE'
  AND "is_permanent_employee" = true
  AND "employment_subtype" IS DISTINCT FROM 'PERMANENT';

ALTER TYPE "EmploymentSubtype" RENAME TO "EmploymentSubtype_old";
CREATE TYPE "EmploymentSubtype" AS ENUM ('PERMANENT', 'NON_PERMANENT');
ALTER TABLE "employee_profiles"
  ALTER COLUMN "employment_subtype" TYPE "EmploymentSubtype"
  USING "employment_subtype"::text::"EmploymentSubtype";
DROP TYPE "EmploymentSubtype_old";

ALTER TABLE "employee_profiles" ALTER COLUMN "employment_status" DROP DEFAULT;
ALTER TYPE "EmployeeStatus" RENAME TO "EmployeeStatus_old";
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'TERMINATED', 'LEFT');
ALTER TABLE "employee_profiles"
  ALTER COLUMN "employment_status" TYPE "EmployeeStatus"
  USING "employment_status"::text::"EmployeeStatus";
ALTER TABLE "employee_profiles" ALTER COLUMN "employment_status" SET DEFAULT 'ACTIVE';
DROP TYPE "EmployeeStatus_old";

COMMIT;
