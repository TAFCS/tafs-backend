-- Payroll calculation engine: a payroll_run covers one campus + date range;
-- payroll_run_lines holds the per-employee computed result (deductions are
-- snapshots at generation time, not live-recomputed, so a finalized run
-- stays stable even if attendance records are corrected later).

CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'FINALIZED');

CREATE TABLE "payroll_runs" (
    "id" SERIAL NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "generated_by" TEXT,
    "generated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMP(6),
    "notes" VARCHAR(500),

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payroll_runs_campus_id_period_start_period_end_idx" ON "payroll_runs"("campus_id", "period_start", "period_end");

CREATE TABLE "payroll_run_lines" (
    "id" SERIAL NOT NULL,
    "payroll_run_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "scheduled_working_days" INTEGER NOT NULL,
    "present_days" INTEGER NOT NULL,
    "late_days" INTEGER NOT NULL,
    "half_days" INTEGER NOT NULL,
    "absent_days" INTEGER NOT NULL,
    "excused_days" INTEGER NOT NULL,
    "unresolved_days" INTEGER NOT NULL DEFAULT 0,
    "total_break_minutes" INTEGER NOT NULL DEFAULT 0,
    "monthly_pay" DECIMAL(12,2) NOT NULL,
    "daily_rate" DECIMAL(12,2) NOT NULL,
    "per_minute_rate" DECIMAL(12,4) NOT NULL,
    "absence_deduction" DECIMAL(12,2) NOT NULL,
    "half_day_deduction" DECIMAL(12,2) NOT NULL,
    "break_deduction" DECIMAL(12,2) NOT NULL,
    "total_deductions" DECIMAL(12,2) NOT NULL,
    "net_pay" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "payroll_run_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payroll_run_lines_payroll_run_id_employee_id_key" ON "payroll_run_lines"("payroll_run_id", "employee_id");

ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_campus_id_fkey"
  FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_payroll_run_id_fkey"
  FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
