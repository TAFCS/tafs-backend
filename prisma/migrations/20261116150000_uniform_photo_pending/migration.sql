-- TAFSD-527: flag new students who are still on their admission photo.
--
-- Photos taken at admission are almost always in house clothes (TAFSD-521
-- audit). Students registered after Ayan Jahangir (CC 7525) are flagged until a
-- school-uniform photo replaces the admission one; admins holding
-- student.directory#uniform_photo.remind get a daily reminder while any are
-- flagged.
--
-- The rules live in the trigger, not in each upload path, because the photo is
-- written from half a dozen places (single upload, bulk photo day, quick
-- admission, edit form, unconfirmed promotion):
--   * INSERT: flagged when cc > 7525. Legacy students (cc <= 7525, including a
--     paper-record CC registered now) are never flagged.
--   * UPDATE: cleared when an existing photo is REPLACED by a different
--     non-empty one while the student is past admission (old status not
--     QUICK_ADMISSION or SOFT_ADMISSION): the "second photo". A retake during
--     admission is still an admission photo, and a student's first photo is
--     treated as the admission photo whenever it arrives, so neither clears it.
--   * Anything that sets the column itself (the "already in uniform" button,
--     a re-flag) is left alone unless the same statement also changes the photo.

ALTER TABLE "students" ADD COLUMN "uniform_photo_pending" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION students_uniform_photo_pending() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.uniform_photo_pending := NEW.cc > 7525;
    RETURN NEW;
  END IF;

  IF NEW.uniform_photo_pending
     AND OLD.photograph_url IS NOT NULL
     AND btrim(OLD.photograph_url) <> ''
     AND NEW.photograph_url IS NOT NULL
     AND btrim(NEW.photograph_url) <> ''
     AND NEW.photograph_url IS DISTINCT FROM OLD.photograph_url
     AND OLD.status NOT IN ('QUICK_ADMISSION', 'SOFT_ADMISSION') THEN
    NEW.uniform_photo_pending := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_students_uniform_photo_pending
  BEFORE INSERT OR UPDATE ON "students"
  FOR EACH ROW EXECUTE FUNCTION students_uniform_photo_pending();

-- Backfill: CC > 7525 students whose current photo is still the only one they
-- have had and did not come from photo day (bulk import), or who have no photo.
-- On 2026-11-16 that matched every house-clothes photo in the TAFSD-521 audit.
UPDATE "students" s
SET "uniform_photo_pending" = true
WHERE s.cc > 7525
  AND s.deleted_at IS NULL
  AND (
    s.photograph_url IS NULL OR btrim(s.photograph_url) = ''
    OR (
      (SELECT count(DISTINCT h.url) FROM "student_photo_history" h WHERE h.student_id = s.cc) <= 1
      AND NOT EXISTS (
        SELECT 1 FROM "student_photo_history" h
        WHERE h.student_id = s.cc AND h.uploaded_by LIKE 'bulk-import%'
      )
    )
  );
