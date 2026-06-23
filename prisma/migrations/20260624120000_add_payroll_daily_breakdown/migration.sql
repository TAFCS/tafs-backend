-- Per-day attendance snapshot for each payroll line — needed so the UI can
-- show every day in the period (working or not) plus the exact
-- classification the engine used, and so it stays a stable snapshot
-- alongside the aggregate counts/deductions already stored here.
ALTER TABLE "payroll_run_lines" ADD COLUMN "daily_breakdown" JSONB NOT NULL DEFAULT '[]';
