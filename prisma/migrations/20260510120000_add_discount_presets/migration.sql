-- CreateTable: discount_presets
CREATE TABLE IF NOT EXISTS "discount_presets" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discount_presets_pkey" PRIMARY KEY ("id")
);

-- Add DISCOUNT to fee_status_enum
ALTER TYPE "fee_status_enum" ADD VALUE IF NOT EXISTS 'DISCOUNT';

-- Make fee_type_id nullable on student_fees
ALTER TABLE "student_fees" ALTER COLUMN "fee_type_id" DROP NOT NULL;

-- Add is_discount column to student_fees
ALTER TABLE "student_fees" ADD COLUMN IF NOT EXISTS "is_discount" BOOLEAN NOT NULL DEFAULT false;

-- Add discount_type_id FK column to student_fees
ALTER TABLE "student_fees" ADD COLUMN IF NOT EXISTS "discount_type_id" INTEGER;

-- AddForeignKey: student_fees.discount_type_id -> discount_presets.id
ALTER TABLE "student_fees" ADD CONSTRAINT "student_fees_discount_type_id_fkey"
    FOREIGN KEY ("discount_type_id") REFERENCES "discount_presets"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- CreateIndex for discount rows
CREATE INDEX IF NOT EXISTS "idx_student_fees_discount" ON "student_fees"("student_id", "is_discount");

-- Drop old unique constraint that required fee_type_id (not valid when nullable for discounts)
ALTER TABLE "student_fees" DROP CONSTRAINT IF EXISTS "student_fees_unique_head";

-- Seed common discount presets
INSERT INTO "discount_presets" ("title", "description", "is_active") VALUES
    ('Supreme Court COVID-19 Discount', 'Discount mandated under Supreme Court COVID-19 relief orders', true),
    ('Sibling Concession', 'Concession granted for siblings enrolled simultaneously', true),
    ('Six-Month Advance Payment Discount', 'Discount for payment of 6 months fees in advance', true),
    ('Full Year Advance Payment Discount', 'Discount for payment of full academic year fees in advance', true),
    ('Need-Based Financial Aid', 'Financial aid granted on the basis of demonstrated need', true),
    ('Staff Child Concession', 'Fee concession for children of school staff members', true)
ON CONFLICT DO NOTHING;
