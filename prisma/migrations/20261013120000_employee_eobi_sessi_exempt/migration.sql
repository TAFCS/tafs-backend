-- TAFSD-278: per-employee EOBI / SESSI exemption, and a snapshot of it on each payroll line.

-- AlterTable
ALTER TABLE "employee_profiles" ADD COLUMN "eobi_exempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sessi_exempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payroll_run_lines" ADD COLUMN "eobi_exempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sessi_exempt" BOOLEAN NOT NULL DEFAULT false;
