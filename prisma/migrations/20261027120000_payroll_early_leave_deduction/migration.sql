-- TAFSD-434: deduct checking out before the expected leaving time.
ALTER TABLE "payroll_run_lines" ADD COLUMN IF NOT EXISTS "total_early_leave_minutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payroll_run_lines" ADD COLUMN IF NOT EXISTS "early_leave_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0;
