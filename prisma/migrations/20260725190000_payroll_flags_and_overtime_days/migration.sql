-- CreateEnum
CREATE TYPE "PayrollFlagType" AS ENUM ('SANDWICH', 'CONSECUTIVE_LATE');

-- CreateEnum
CREATE TYPE "PayrollFlagStatus" AS ENUM ('PENDING', 'APPLIED', 'EXEMPTED');

-- AlterTable
ALTER TABLE "payroll_run_lines" ADD COLUMN     "consecutive_late_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "overtime_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sandwich_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payroll_flags" (
    "id" SERIAL NOT NULL,
    "payroll_run_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "flag_type" "PayrollFlagType" NOT NULL,
    "anchor_date" DATE NOT NULL,
    "dates" JSONB NOT NULL,
    "deduction_days" DECIMAL(6,2) NOT NULL,
    "deduction_amount" DECIMAL(12,2) NOT NULL,
    "status" "PayrollFlagStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_flags_payroll_run_id_employee_id_idx" ON "payroll_flags"("payroll_run_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_flags_payroll_run_id_employee_id_flag_type_anchor_d_key" ON "payroll_flags"("payroll_run_id", "employee_id", "flag_type", "anchor_date");

-- AddForeignKey
ALTER TABLE "payroll_flags" ADD CONSTRAINT "payroll_flags_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_flags" ADD CONSTRAINT "payroll_flags_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

