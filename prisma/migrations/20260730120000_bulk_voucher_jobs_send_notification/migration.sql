-- AlterTable
-- Records whether the admin asked for an instant "voucher issued" push to parents
-- at generation time. Defaults to true so historical jobs match prior behaviour.
ALTER TABLE "bulk_voucher_jobs"
  ADD COLUMN "send_notification" BOOLEAN NOT NULL DEFAULT true;
