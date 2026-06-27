-- CreateEnum
CREATE TYPE "AttendanceObjectionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- AlterTable: payroll_run_lines disbursement tracking
ALTER TABLE "payroll_run_lines" ADD COLUMN "disbursed_at" TIMESTAMP(0),
ADD COLUMN "disbursed_by" TEXT,
ADD COLUMN "disbursement_notes" VARCHAR(300);

-- AlterTable: fcm_device_tokens staff support
ALTER TABLE "fcm_device_tokens" ALTER COLUMN "family_id" DROP NOT NULL;
ALTER TABLE "fcm_device_tokens" ADD COLUMN "user_id" TEXT;

-- CreateTable
CREATE TABLE "attendance_objections" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "attendance_date" DATE NOT NULL,
    "scan_id" INTEGER,
    "claimed_time" TIMESTAMP(6) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "AttendanceObjectionStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(6),
    "admin_notes" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "attendance_objections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_objections_employee_id_attendance_date_idx" ON "attendance_objections"("employee_id", "attendance_date");
CREATE INDEX "attendance_objections_status_idx" ON "attendance_objections"("status");
CREATE INDEX "fcm_device_tokens_user_id_idx" ON "fcm_device_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_disbursed_by_fkey" FOREIGN KEY ("disbursed_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "attendance_objections" ADD CONSTRAINT "attendance_objections_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_objections" ADD CONSTRAINT "attendance_objections_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "zk_attendance_scans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "attendance_objections" ADD CONSTRAINT "attendance_objections_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "fcm_device_tokens" ADD CONSTRAINT "fcm_device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
