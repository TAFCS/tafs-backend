-- Drop the old unique constraint that prevented multiple discount rows
ALTER TABLE "student_fees" DROP CONSTRAINT IF EXISTS "student_fees_unique_head";

-- Create a new PARTIAL unique constraint that only applies to regular fee rows (is_discount = false)
-- This allows discount rows to exist without violating uniqueness
ALTER TABLE "student_fees" 
ADD CONSTRAINT "student_fees_unique_regular_head" 
UNIQUE ("student_id", "fee_type_id", "fee_date") 
WHERE "is_discount" = false;

-- Create partial index for better query performance on non-discount rows
CREATE INDEX IF NOT EXISTS "idx_student_fees_non_discount" 
ON "student_fees" ("student_id", "fee_type_id", "fee_date") 
WHERE "is_discount" = false;
