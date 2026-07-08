-- CreateEnum
CREATE TYPE "CheckInSource" AS ENUM ('FIXED', 'TIMETABLE');

-- AlterTable
ALTER TABLE "employee_profiles" ADD COLUMN "check_in_source" "CheckInSource" NOT NULL DEFAULT 'FIXED';
