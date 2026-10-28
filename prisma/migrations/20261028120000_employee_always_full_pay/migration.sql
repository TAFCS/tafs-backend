-- TAFSD-437: "always full pay" — no attendance deductions for this employee.
ALTER TABLE "employee_profiles" ADD COLUMN IF NOT EXISTS "always_full_pay" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payroll_run_lines" ADD COLUMN IF NOT EXISTS "always_full_pay" BOOLEAN NOT NULL DEFAULT false;
