-- TAFSD-383: per-cycle EOBI / SESSI / income tax waivers on a payroll line.
ALTER TABLE "payroll_run_lines" ADD COLUMN "eobi_waived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payroll_run_lines" ADD COLUMN "sessi_waived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payroll_run_lines" ADD COLUMN "income_tax_waived" BOOLEAN NOT NULL DEFAULT false;
