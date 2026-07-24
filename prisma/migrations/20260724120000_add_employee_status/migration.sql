-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'TERMINATED', 'PERMANENT', 'LEFT', 'FAMILY');

-- AlterTable
ALTER TABLE "employee_profiles"
  ADD COLUMN "employment_status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX "employee_profiles_employment_status_idx" ON "employee_profiles"("employment_status");
