-- TAFSD-471/472: switch attendance deductions off for one employee on one run, by type or by day.
ALTER TABLE "payroll_run_lines" ADD COLUMN IF NOT EXISTS "deduction_waivers" JSONB NOT NULL DEFAULT '{}';
