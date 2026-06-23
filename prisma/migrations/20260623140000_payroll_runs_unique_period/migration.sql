-- Payroll period is now a fixed 26th-to-25th cycle derived from year+month,
-- so (campus_id, period_start, period_end) is a natural key: regenerating a
-- DRAFT for the same month should replace it in place, not pile up duplicates.
DROP INDEX IF EXISTS "payroll_runs_campus_id_period_start_period_end_idx";
CREATE UNIQUE INDEX "payroll_runs_campus_id_period_start_period_end_key" ON "payroll_runs"("campus_id", "period_start", "period_end");
