-- Create StaffCategory enum
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

-- Drop old teacher_category column and enum
ALTER TABLE "employee_profiles" DROP COLUMN IF EXISTS "teacher_category";
DROP TYPE IF EXISTS "TeacherCategory";

-- Add new staff_category column
ALTER TABLE "employee_profiles" ADD COLUMN "staff_category" "StaffCategory";

-- Add EMPLOYEES login role
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'EMPLOYEES';
