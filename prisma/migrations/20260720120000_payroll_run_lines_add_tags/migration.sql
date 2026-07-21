-- AlterTable
ALTER TABLE "payroll_run_lines"
ADD COLUMN "has_salary" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "is_mapped" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "has_punches" BOOLEAN NOT NULL DEFAULT true;
