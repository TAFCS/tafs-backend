-- AlterTable
ALTER TABLE "bulk_voucher_jobs" ADD COLUMN "hold_for_release" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "vouchers" ADD COLUMN "bulk_voucher_job_id" INTEGER,
ADD COLUMN "released_to_parent_at" TIMESTAMP(6),
ADD COLUMN "released_by" VARCHAR(100);

-- Backfill: every pre-existing voucher is already parent-visible.
UPDATE "vouchers"
SET "released_to_parent_at" = COALESCE("generated_at", "issue_date"::timestamp)
WHERE "released_to_parent_at" IS NULL;

-- CreateIndex
CREATE INDEX "vouchers_released_to_parent_at_idx" ON "vouchers"("released_to_parent_at");

-- CreateIndex
CREATE INDEX "vouchers_bulk_voucher_job_id_idx" ON "vouchers"("bulk_voucher_job_id");

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_bulk_voucher_job_id_fkey" FOREIGN KEY ("bulk_voucher_job_id") REFERENCES "bulk_voucher_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
