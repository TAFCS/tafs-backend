-- Frozen WAIVED challan, the exact mirror of the frozen PAID receipt
-- (paid_pdf_url / paid_pdf_filename / paid_pdf_generated_at).
--
-- A waived challan is a permanent artifact of a write-off decision, not a
-- cache: minted once when the voucher is waived and served byte-for-byte
-- afterwards. Cleared ONLY by unwaiveVoucher(), the exact counterpart of
-- clearDeposit() clearing paid_pdf_url on a payment reversal.
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "waived_pdf_url" TEXT;
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "waived_pdf_filename" VARCHAR(255);
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "waived_pdf_generated_at" TIMESTAMP(6);
