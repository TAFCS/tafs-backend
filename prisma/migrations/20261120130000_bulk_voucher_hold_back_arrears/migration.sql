-- TAFSD-547: a bulk voucher job can hold back students with arrears (as
-- computed by VouchersService.computeArrears) and report them; a follow-up job
-- issues those students later and points back at the job that held them.

-- AlterTable
ALTER TABLE "bulk_voucher_jobs" ADD COLUMN "hold_back_arrears" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "held_back_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pay_immediately_custom_dates" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "is_revised" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "source_job_id" INTEGER;

-- CreateIndex
CREATE INDEX "idx_bulk_jobs_source_job_id" ON "bulk_voucher_jobs"("source_job_id");

-- AddForeignKey
ALTER TABLE "bulk_voucher_jobs" ADD CONSTRAINT "bulk_voucher_jobs_source_job_id_fkey" FOREIGN KEY ("source_job_id") REFERENCES "bulk_voucher_jobs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
