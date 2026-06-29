-- Saturday schedules: campus-level -> per-employee (existing rows cleared)
DELETE FROM "teacher_saturday_schedules";

ALTER TABLE "teacher_saturday_schedules" DROP CONSTRAINT IF EXISTS "teacher_saturday_schedules_campus_id_fkey";
DROP INDEX IF EXISTS "teacher_saturday_schedules_campus_id_date_key";
DROP INDEX IF EXISTS "teacher_saturday_schedules_campus_id_date_idx";

ALTER TABLE "teacher_saturday_schedules" DROP COLUMN IF EXISTS "campus_id";

ALTER TABLE "teacher_saturday_schedules" ADD COLUMN IF NOT EXISTS "employee_id" INTEGER NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "teacher_saturday_schedules_employee_id_date_key"
  ON "teacher_saturday_schedules"("employee_id", "date");

CREATE INDEX IF NOT EXISTS "teacher_saturday_schedules_employee_id_date_idx"
  ON "teacher_saturday_schedules"("employee_id", "date");

DO $$ BEGIN
  ALTER TABLE "teacher_saturday_schedules" ADD CONSTRAINT "teacher_saturday_schedules_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
