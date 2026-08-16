-- ============================================================================
-- ARCHIVED — DO NOT RUN. Kept only as a record of what was executed historically.
--
-- WHY THIS IS UNSAFE
--
-- 1. Step 3 (UPDATE ... SET student_cc = real_s.cc) silently RE-POINTS live,
--    active mappings using a `gr_number = device_pin` heuristic. Its uniqueness
--    check counts only GR matches and is blind to CC collisions entirely.
--    Student GR numbers and CCs share one numeric namespace: 199 known cases
--    where student A's gr_number equals student B's cc. This is the mechanism
--    that made pin 6102 credit MUHAMMAD HAIB MIRZA's attendance to AIZA BAIG.
--
-- 2. Step 2 creates mappings from a bare `cc = device_pin::int` guess with no
--    cross-check against GR numbers.
--
-- 3. Step 4 attaches orphan scans without recomputing attendance_*_daily, so
--    scan attribution and daily attendance silently disagree afterwards.
--
-- WHAT TO USE INSTEAD
--   * Mapping changes:  POST / PATCH / DELETE /attendance/zk-device-mappings
--                       (collision-guarded, and re-resolves history inline)
--   * Bulk repair:      POST /attendance/zk-scan-resolution/resolve  (dry_run first)
--   * Diagnosis:        npx ts-node scripts/audit-zk-scan-attribution.ts
--
-- psql aborts here before executing anything below.
-- ============================================================================
\echo '*** ARCHIVED — DO NOT RUN. See header; use the zk-scan-resolution endpoint. ***'
\quit

-- backfill-student-device-pin-mappings.sql
--
-- Creates missing STUDENT device_user_mappings when an unmapped ZK pin uniquely
-- matches a student by:
--   1) Pure-numeric GR number (device stores GR as PIN), pin length >= 3
--   2) Student CC (device stores CC as PIN), pin length >= 3
--
-- Then attaches orphan zk_attendance_scans (person_type/student_cc null) to the
-- matching active STUDENT mapping.
--
-- Safety:
--   - Skips prefixed GRs (KF-A4, A-N12) whose digits alone collide with short PINs
--   - Only unique GR matches
--   - Does not overwrite existing (device_sn, device_pin) mapping rows
--   - Prefers GR match over CC match when both could apply

BEGIN;

-- 1) Insert mappings for unmapped pins with a unique pure-numeric GR match
INSERT INTO device_user_mappings (
  device_sn, device_pin, person_type, student_cc, display_name, is_active, notes, created_at, updated_at
)
SELECT
  u.device_sn,
  u.device_pin,
  'STUDENT'::"DevicePersonType",
  s.cc,
  s.full_name,
  true,
  'backfill: matched device_pin to unique student GR digits',
  now(),
  now()
FROM (
  SELECT DISTINCT device_sn, device_pin
  FROM zk_attendance_scans
  WHERE student_cc IS NULL
    AND person_type IS NULL
    AND device_pin ~ '^\d+$'
    AND length(device_pin) >= 3
) u
JOIN students s
  ON s.deleted_at IS NULL
 AND s.gr_number ~ '^\d+$'
 AND s.gr_number = u.device_pin
WHERE NOT EXISTS (
  SELECT 1
  FROM device_user_mappings m
  WHERE m.device_sn = u.device_sn AND m.device_pin = u.device_pin
)
AND (
  SELECT COUNT(*)
  FROM students s2
  WHERE s2.deleted_at IS NULL
    AND s2.gr_number ~ '^\d+$'
    AND s2.gr_number = u.device_pin
) = 1;

-- 2) Insert mappings for unmapped pins that equal a student CC (pin length >= 3)
INSERT INTO device_user_mappings (
  device_sn, device_pin, person_type, student_cc, display_name, is_active, notes, created_at, updated_at
)
SELECT
  u.device_sn,
  u.device_pin,
  'STUDENT'::"DevicePersonType",
  s.cc,
  s.full_name,
  true,
  'backfill: matched device_pin to student CC',
  now(),
  now()
FROM (
  SELECT DISTINCT device_sn, device_pin
  FROM zk_attendance_scans
  WHERE student_cc IS NULL
    AND person_type IS NULL
    AND device_pin ~ '^\d+$'
    AND length(device_pin) >= 3
) u
JOIN students s
  ON s.deleted_at IS NULL
 AND s.cc = u.device_pin::int
WHERE NOT EXISTS (
  SELECT 1
  FROM device_user_mappings m
  WHERE m.device_sn = u.device_sn AND m.device_pin = u.device_pin
);

-- 3) Fix active STUDENT mappings where pin uniquely matches another student's
--    pure-numeric GR but student_cc points elsewhere
UPDATE device_user_mappings m
SET
  student_cc = real_s.cc,
  display_name = COALESCE(m.display_name, real_s.full_name),
  notes = CASE
    WHEN m.notes IS NULL OR btrim(m.notes) = '' THEN 'backfill: corrected student_cc via unique GR match'
    ELSE m.notes || ' | backfill: corrected student_cc via unique GR match'
  END,
  updated_at = now()
FROM students real_s
WHERE m.person_type = 'STUDENT'
  AND m.is_active = true
  AND m.device_pin ~ '^\d+$'
  AND length(m.device_pin) >= 3
  AND real_s.deleted_at IS NULL
  AND real_s.gr_number ~ '^\d+$'
  AND real_s.gr_number = m.device_pin
  AND real_s.cc IS DISTINCT FROM m.student_cc
  AND (
    SELECT COUNT(*)
    FROM students s2
    WHERE s2.deleted_at IS NULL
      AND s2.gr_number ~ '^\d+$'
      AND s2.gr_number = m.device_pin
  ) = 1;

-- 4) Attach orphan scans to active STUDENT mappings on the same device_sn + pin
UPDATE zk_attendance_scans sc
SET
  person_type = m.person_type,
  student_cc = m.student_cc,
  employee_id = NULL
FROM device_user_mappings m
WHERE m.device_sn = sc.device_sn
  AND m.device_pin = sc.device_pin
  AND m.is_active = true
  AND m.person_type = 'STUDENT'
  AND m.student_cc IS NOT NULL
  AND sc.student_cc IS NULL
  AND sc.person_type IS NULL;

COMMIT;
