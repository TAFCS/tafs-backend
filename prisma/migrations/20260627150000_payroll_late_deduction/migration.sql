-- Add late-arrival deduction columns to payroll_run_lines.
-- total_late_minutes: sum of minutes late across all LATE days in the period.
-- late_deduction: total_late_minutes * per_minute_rate, deducted from net_pay.
-- Both default to 0 so existing finalized runs are unaffected.

ALTER TABLE "payroll_run_lines"
  ADD COLUMN "total_late_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "late_deduction"     DECIMAL(12,2) NOT NULL DEFAULT 0;
