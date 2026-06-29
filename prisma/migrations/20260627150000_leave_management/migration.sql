-- Leave management: leave_types.code, leave_requests, teacher_saturday_schedules, enums

ALTER TYPE "StaffAttendanceStatus" ADD VALUE IF NOT EXISTS 'UNPAID_LEAVE';
ALTER TYPE "AttendanceSource" ADD VALUE IF NOT EXISTS 'LEAVE';

DO $$ BEGIN
  CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "leave_types" ADD COLUMN IF NOT EXISTS "code" VARCHAR(20);

UPDATE "leave_types" SET "code" = 'SICK' WHERE "name" = 'Sick Leave' AND "code" IS NULL;
UPDATE "leave_types" SET "code" = 'CASUAL' WHERE "name" = 'Casual Leave' AND "code" IS NULL;
UPDATE "leave_types" SET "code" = 'ANNUAL' WHERE "name" = 'Annual Leave' AND "code" IS NULL;
UPDATE "leave_types" SET "code" = 'UNPAID' WHERE "name" = 'Unpaid Leave' AND "code" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "leave_types_code_key" ON "leave_types"("code");

ALTER TABLE "employee_profiles"
  ADD COLUMN IF NOT EXISTS "is_permanent_employee" BOOLEAN NOT NULL DEFAULT false;

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

CREATE INDEX IF NOT EXISTS "leave_requests_employee_id_idx" ON "leave_requests"("employee_id");
CREATE INDEX IF NOT EXISTS "leave_requests_status_idx" ON "leave_requests"("status");
CREATE INDEX IF NOT EXISTS "leave_requests_start_date_end_date_idx" ON "leave_requests"("start_date", "end_date");

DO $$ BEGIN
  ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_fkey"
    FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "teacher_saturday_schedules" (
  "id" SERIAL NOT NULL,
  "campus_id" INTEGER NOT NULL,
  "date" DATE NOT NULL,
  "marked_by" VARCHAR(255) NOT NULL,
  "marked_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "teacher_saturday_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "teacher_saturday_schedules_campus_id_date_key"
  ON "teacher_saturday_schedules"("campus_id", "date");
CREATE INDEX IF NOT EXISTS "teacher_saturday_schedules_campus_id_date_idx"
  ON "teacher_saturday_schedules"("campus_id", "date");

DO $$ BEGIN
  ALTER TABLE "teacher_saturday_schedules" ADD CONSTRAINT "teacher_saturday_schedules_campus_id_fkey"
    FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "teacher_saturday_schedules" ADD CONSTRAINT "teacher_saturday_schedules_marked_by_fkey"
    FOREIGN KEY ("marked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "payroll_run_lines"
  ADD COLUMN IF NOT EXISTS "unpaid_leave_days" INTEGER NOT NULL DEFAULT 0;
