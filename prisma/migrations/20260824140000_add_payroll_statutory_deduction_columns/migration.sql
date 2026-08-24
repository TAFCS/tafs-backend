-- AlterTable
ALTER TABLE "payroll_run_lines" ADD COLUMN     "eobi_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "income_tax_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "eobi_employer_cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sessi_employer_cost" DECIMAL(12,2) NOT NULL DEFAULT 0;
