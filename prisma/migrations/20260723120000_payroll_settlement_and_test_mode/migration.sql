-- Payroll test mode: a test run is scoped to hand-picked employees rather than
-- a whole campus, and must be able to coexist with a real run for the same
-- campus + period without violating uniqueness — widen the natural key to
-- include is_test.
ALTER TABLE "payroll_runs" ADD COLUMN IF NOT EXISTS "is_test" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX IF EXISTS "payroll_runs_campus_id_period_start_period_end_key";
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_runs_campus_id_period_start_period_end_is_test_key"
  ON "payroll_runs"("campus_id", "period_start", "period_end", "is_test");

-- Overtime totals are computed once at generation time (snapshot, same
-- philosophy as every other deduction column) so settlement never has to
-- recompute attendance live.
ALTER TABLE "payroll_run_lines" ADD COLUMN IF NOT EXISTS "total_overtime_minutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payroll_run_lines" ADD COLUMN IF NOT EXISTS "scheduled_minutes_per_day" INTEGER NOT NULL DEFAULT 0;

-- Settlement extras (overtime reward config, cash bonus, payslip) live in
-- their own table — kept separate from payroll_run_lines specifically so the
-- employee self-service endpoints (which spread the whole line row) can
-- never accidentally leak the off-the-books cash bonus.
DO $$ BEGIN
  CREATE TYPE "OvertimeRateType" AS ENUM ('PER_MINUTE', 'PER_HOUR', 'PER_DAY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "payroll_settlements" (
    "id" SERIAL NOT NULL,
    "payroll_run_line_id" INTEGER NOT NULL,
    "overtime_rate_type" "OvertimeRateType",
    "overtime_rate_amount" DECIMAL(12,2),
    "overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "overtime_reward_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cash_bonus_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net_paid" DECIMAL(12,2) NOT NULL,
    "payslip_pdf_url" TEXT,
    "settled_at" TIMESTAMP(0) NOT NULL,
    "settled_by" TEXT NOT NULL,
    "settlement_notes" VARCHAR(300),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_settlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_settlements_payroll_run_line_id_key" ON "payroll_settlements"("payroll_run_line_id");

DO $$ BEGIN
  ALTER TABLE "payroll_settlements" ADD CONSTRAINT "payroll_settlements_payroll_run_line_id_fkey"
    FOREIGN KEY ("payroll_run_line_id") REFERENCES "payroll_run_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payroll_settlements" ADD CONSTRAINT "payroll_settlements_settled_by_fkey"
    FOREIGN KEY ("settled_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
