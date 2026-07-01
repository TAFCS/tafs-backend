-- Add section column to audit_logs for module-based colour coding
ALTER TABLE "audit_logs" ADD COLUMN "section" VARCHAR(50);

-- Backfill existing rows based on entity_type
UPDATE "audit_logs" SET "section" = CASE
  WHEN "entity_type" IN ('STUDENT', 'GUARDIAN', 'FAMILY', 'TRANSFER') THEN 'student'
  WHEN "entity_type" IN ('VOUCHER', 'DEPOSIT') THEN 'finance'
  ELSE NULL
END;

-- Index for filtering logs by section
CREATE INDEX "audit_logs_section_idx" ON "audit_logs"("section");
