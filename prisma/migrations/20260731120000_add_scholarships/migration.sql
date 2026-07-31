-- CreateTable: scholarship_presets
CREATE TABLE IF NOT EXISTS "scholarship_presets" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scholarship_presets_pkey" PRIMARY KEY ("id")
);

-- Add amount_after_discount (intermediate: gross minus system discount, before scholarship)
ALTER TABLE "student_fees" ADD COLUMN IF NOT EXISTS "amount_after_discount" DECIMAL(12,2);

-- Add scholarship_percentage (0-100, MTF-only, enforced at the application layer)
ALTER TABLE "student_fees" ADD COLUMN IF NOT EXISTS "scholarship_percentage" DECIMAL(5,2);

-- Add scholarship_type_id FK column to student_fees
ALTER TABLE "student_fees" ADD COLUMN IF NOT EXISTS "scholarship_type_id" INTEGER;

-- AddForeignKey: student_fees.scholarship_type_id -> scholarship_presets.id
ALTER TABLE "student_fees" ADD CONSTRAINT "student_fees_scholarship_type_id_fkey"
    FOREIGN KEY ("scholarship_type_id") REFERENCES "scholarship_presets"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Freeze scholarship snapshot on voucher_heads, mirroring discount_amount/discount_label
ALTER TABLE "voucher_heads" ADD COLUMN IF NOT EXISTS "scholarship_amount" DECIMAL(12,2) DEFAULT 0;
ALTER TABLE "voucher_heads" ADD COLUMN IF NOT EXISTS "scholarship_label" VARCHAR(100);

-- Backfill amount_after_discount for existing rows so it always reflects the
-- pre-scholarship amount (no scholarships exist yet, so this equals amount).
UPDATE "student_fees" SET "amount_after_discount" = "amount" WHERE "amount_after_discount" IS NULL;
