-- TAFSD-500: EOBI and income tax are taken only from pay left after attendance
-- cuts; what doesn't fit is carried to the next cycle. Additive only.
ALTER TABLE "payroll_run_lines"
  ADD COLUMN "statutory_due" JSONB,
  ADD COLUMN "eobi_carried_in" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "income_tax_carried_in" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "eobi_carried_out" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "income_tax_carried_out" DECIMAL(12,2) NOT NULL DEFAULT 0;
