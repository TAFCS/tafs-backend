-- Freeze the PAID receipt. Once a voucher's paid PDF is generated, its URL and
-- download filename are pinned forever, so a later gr_number change can never
-- alter the name (or force a re-render) of an already-issued receipt.
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "paid_pdf_url" TEXT;
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "paid_pdf_filename" VARCHAR(255);
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "paid_pdf_generated_at" TIMESTAMP(6);
