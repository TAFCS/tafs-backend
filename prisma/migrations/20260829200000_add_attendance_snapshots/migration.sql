-- CreateEnum
CREATE TYPE "ExpectedTimeSource" AS ENUM ('OVERRIDE', 'TIMETABLE', 'FIXED', 'POLICY', 'NONE');

-- AlterTable
ALTER TABLE "attendance_roll_sessions" ADD COLUMN     "snapshot_employee_id" INTEGER,
ADD COLUMN     "snapshot_subject_id" INTEGER;

-- AlterTable
ALTER TABLE "attendance_staff_daily" ADD COLUMN     "expected_check_in_snapshot" TIMESTAMP(6),
ADD COLUMN     "expected_check_out_snapshot" TIMESTAMP(6),
ADD COLUMN     "expected_grace_minutes_snapshot" INTEGER,
ADD COLUMN     "expected_time_source_snapshot" "ExpectedTimeSource";

-- AddForeignKey
ALTER TABLE "attendance_roll_sessions" ADD CONSTRAINT "attendance_roll_sessions_snapshot_subject_id_fkey" FOREIGN KEY ("snapshot_subject_id") REFERENCES "subjects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_roll_sessions" ADD CONSTRAINT "attendance_roll_sessions_snapshot_employee_id_fkey" FOREIGN KEY ("snapshot_employee_id") REFERENCES "employee_profiles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

