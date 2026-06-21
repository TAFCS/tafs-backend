-- Extend academic calendar for scoped holidays and employee work schedules
-- Idempotent: safe to re-run if partially applied

ALTER TABLE "academic_calendar_days" ADD COLUMN IF NOT EXISTS "applies_to" VARCHAR(20) NOT NULL DEFAULT 'STUDENT';

DROP INDEX IF EXISTS "academic_calendar_days_campus_id_date_key";

ALTER TABLE "academic_calendar_days" ADD COLUMN IF NOT EXISTS "class_id" INTEGER;
ALTER TABLE "academic_calendar_days" ADD COLUMN IF NOT EXISTS "section_id" INTEGER;
ALTER TABLE "academic_calendar_days" ADD COLUMN IF NOT EXISTS "department_id" INTEGER;
ALTER TABLE "academic_calendar_days" ADD COLUMN IF NOT EXISTS "employee_id" INTEGER;
ALTER TABLE "academic_calendar_days" ADD COLUMN IF NOT EXISTS "created_by" TEXT;

ALTER TYPE "RollRecordStatus" ADD VALUE IF NOT EXISTS 'EXCUSED';
ALTER TYPE "AttendanceSource" ADD VALUE IF NOT EXISTS 'SYSTEM';

CREATE TABLE IF NOT EXISTS "employee_work_schedules" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "is_working" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "employee_work_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "employee_work_schedules_employee_id_day_of_week_key"
    ON "employee_work_schedules"("employee_id", "day_of_week");

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'employee_work_schedules_employee_id_fkey'
    ) THEN
        ALTER TABLE "employee_work_schedules"
            ADD CONSTRAINT "employee_work_schedules_employee_id_fkey"
            FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'academic_calendar_days_class_id_fkey'
    ) THEN
        ALTER TABLE "academic_calendar_days"
            ADD CONSTRAINT "academic_calendar_days_class_id_fkey"
            FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'academic_calendar_days_section_id_fkey'
    ) THEN
        ALTER TABLE "academic_calendar_days"
            ADD CONSTRAINT "academic_calendar_days_section_id_fkey"
            FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'academic_calendar_days_department_id_fkey'
    ) THEN
        ALTER TABLE "academic_calendar_days"
            ADD CONSTRAINT "academic_calendar_days_department_id_fkey"
            FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'academic_calendar_days_employee_id_fkey'
    ) THEN
        ALTER TABLE "academic_calendar_days"
            ADD CONSTRAINT "academic_calendar_days_employee_id_fkey"
            FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "academic_calendar_days_campus_id_date_applies_to_idx"
    ON "academic_calendar_days"("campus_id", "date", "applies_to");

CREATE INDEX IF NOT EXISTS "academic_calendar_days_class_id_section_id_idx"
    ON "academic_calendar_days"("class_id", "section_id");
