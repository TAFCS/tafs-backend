-- TAFSD-474: keep the time of the punch being objected to. Accepting an
-- objection rewrites that scan's scan_time to the claimed time, which erased
-- what the employee was objecting to.
ALTER TABLE "attendance_objections" ADD COLUMN IF NOT EXISTS "original_scan_time" TIMESTAMP(6);

-- Objections not yet accepted still point at an untouched scan.
UPDATE "attendance_objections" o
SET "original_scan_time" = s."scan_time"
FROM "zk_attendance_scans" s
WHERE o."scan_id" = s."id"
  AND o."status" <> 'ACCEPTED'
  AND o."original_scan_time" IS NULL;
