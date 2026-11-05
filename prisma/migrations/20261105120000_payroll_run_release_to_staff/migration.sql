-- TAFSD-478: release a payroll run to the staff app separately from finalizing it.
ALTER TABLE "payroll_runs" ADD COLUMN IF NOT EXISTS "released_to_staff_at" TIMESTAMP(6);
ALTER TABLE "payroll_runs" ADD COLUMN IF NOT EXISTS "released_by" VARCHAR(255);

-- Staff could already see every run before this; keep cycles before 26 Sep 2026
-- visible. The 26 Sep - 25 Oct 2026 cycle (run alongside the manual payroll as a
-- test) and later ones stay hidden until someone releases them.
UPDATE "payroll_runs"
SET "released_to_staff_at" = COALESCE("finalized_at", "generated_at"),
    "released_by" = 'backfill (TAFSD-478)'
WHERE "is_test" = false
  AND "period_start" < DATE '2026-09-26'
  AND "released_to_staff_at" IS NULL;
