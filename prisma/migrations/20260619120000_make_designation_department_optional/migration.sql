-- Make designations.department_id optional: departments table is empty right
-- now and we need to seed real designation titles from HR data before any
-- department structure exists.
ALTER TABLE "designations" DROP CONSTRAINT IF EXISTS "designations_department_id_fkey";
ALTER TABLE "designations" ALTER COLUMN "department_id" DROP NOT NULL;
ALTER TABLE "designations" ADD CONSTRAINT "designations_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
