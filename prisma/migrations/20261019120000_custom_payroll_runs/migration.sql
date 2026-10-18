-- TAFSD-271: custom payroll runs (hand-picked employees, any date range).
CREATE TYPE "PayrollRunKind" AS ENUM ('REGULAR', 'CUSTOM');

ALTER TABLE "payroll_runs" ADD COLUMN "kind" "PayrollRunKind" NOT NULL DEFAULT 'REGULAR';

DROP INDEX IF EXISTS "payroll_runs_campus_id_period_start_period_end_is_test_key";
CREATE UNIQUE INDEX "payroll_runs_campus_id_period_start_period_end_is_test_kind_key"
  ON "payroll_runs"("campus_id", "period_start", "period_end", "is_test", "kind");
