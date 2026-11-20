-- TAFSD-541: delete a wrong version of a student document instead of archiving
-- the whole document. The row is kept, marked deleted with who/when/why; the
-- file itself is removed from storage. Deleted versions are excluded from every
-- list, link, count and report, and the current version is the highest
-- non-deleted one. Nullable columns only: no backfill, no rewrite.

ALTER TABLE "student_document_versions"
  ADD COLUMN "deleted_at" TIMESTAMP(6),
  ADD COLUMN "deleted_by" VARCHAR(255),
  ADD COLUMN "delete_reason" VARCHAR(500);
