-- TAFSD-462: whether an approved leave is paid, decided at approval. For
-- sick leave the approver chooses; other types follow leave_types.is_paid.
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "is_paid" BOOLEAN;

-- Leave approved before this was decided by its type alone.
UPDATE "leave_requests" r
SET "is_paid" = t."is_paid"
FROM "leave_types" t
WHERE r."leave_type_id" = t."id"
  AND r."status" = 'APPROVED'
  AND r."is_paid" IS NULL;
