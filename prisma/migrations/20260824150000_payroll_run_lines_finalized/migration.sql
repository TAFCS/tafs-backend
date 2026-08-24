-- AlterTable
ALTER TABLE "payroll_run_lines" ADD COLUMN     "finalized_at" TIMESTAMP(6),
ADD COLUMN     "finalized_by" TEXT;

-- AddForeignKey
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_finalized_by_fkey" FOREIGN KEY ("finalized_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Backfill: a non-test run that was already whole-run finalized under the old
-- model implies every one of its lines was effectively locked, so stamp that
-- same finalized_at onto each line. finalized_by is left NULL — the old
-- whole-run finalize action never recorded a per-line actor. Test-run lines
-- are excluded: they're fully disposable and get wiped on the next
-- "Generate Test Run" regardless of this backfill.
UPDATE "payroll_run_lines" pl
SET "finalized_at" = pr."finalized_at"
FROM "payroll_runs" pr
WHERE pl."payroll_run_id" = pr."id"
  AND pr."status" = 'FINALIZED'
  AND pr."is_test" = false
  AND pr."finalized_at" IS NOT NULL;
