-- AlterTable
ALTER TABLE "employee_profiles" ADD COLUMN "date_of_leaving" DATE;

-- AlterTable
ALTER TABLE "payroll_run_lines" ADD COLUMN "after_leaving_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "full_pay_override" BOOLEAN NOT NULL DEFAULT false;
