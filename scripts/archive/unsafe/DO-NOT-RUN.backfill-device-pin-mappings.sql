-- ============================================================================
-- ARCHIVED — DO NOT RUN. Kept only as a record of what was executed historically.
--
-- WHY THIS IS UNSAFE
--
-- 1. Reconstructs employee_code from device_pin via a string heuristic
--    ("030056" -> "03-0056") that its own header admits was inferred from just
--    two examples. It is unvalidated for any other pin shape.
--
-- 2. Inserts is_active = true STAFF mappings with no uniqueness guard on the
--    employee side, and no collision check against student CCs/GR numbers that
--    may occupy the same pin values on the same device fleet.
--
-- 3. Writes mappings without recomputing attendance, so scan attribution and
--    attendance_*_daily silently disagree afterwards.
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

-- backfill-device-pin-mappings.sql
--
-- Fills in device_user_mappings for unmapped ZK device pins by reconstructing
-- the employee_code from the raw device_pin and matching against
-- employee_profiles.
--
-- Transform rule (confirmed against two known examples: 600564 -> 06-00564,
-- and 030056 -> 03-0056):
--   - if the pin starts with '0', the department is its first TWO characters
--     (e.g. "03" from "030056"), and the number is everything after.
--   - otherwise, the department is just the first character, left-padded to
--     2 digits (e.g. "6" -> "06"), and the number is everything after.
--
--   CASE WHEN device_pin LIKE '0%'
--     THEN substring(device_pin from 1 for 2) || '-' || substring(device_pin from 3)
--     ELSE lpad(substring(device_pin from 1 for 1), 2, '0') || '-' || substring(device_pin from 2)
--   END
--
-- Only inserts a mapping where the reconstructed code matches exactly one
-- existing employee_profiles.employee_code, and only for (device_sn,
-- device_pin) pairs that don't already have a mapping row.

INSERT INTO device_user_mappings (device_sn, device_pin, person_type, employee_id, is_active, created_at, updated_at)
SELECT DISTINCT
  s.device_sn,
  s.device_pin,
  'STAFF'::"DevicePersonType",
  ep.id,
  true,
  now(),
  now()
FROM zk_attendance_scans s
JOIN employee_profiles ep
  ON ep.employee_code = (
    CASE WHEN s.device_pin LIKE '0%'
      THEN substring(s.device_pin from 1 for 2) || '-' || substring(s.device_pin from 3)
      ELSE lpad(substring(s.device_pin from 1 for 1), 2, '0') || '-' || substring(s.device_pin from 2)
    END
  )
WHERE s.person_type IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM device_user_mappings dm
    WHERE dm.device_sn = s.device_sn AND dm.device_pin = s.device_pin
  );

-- After running this, re-run scripts/attendance-grid-26jun-13jul.sql's "unmapped"
-- block (or ZkAttendanceMappingService.getUnmappedPins()) to see what's left —
-- those are pins with no reconstructable match, e.g. reserved/test PINs like
-- 9999 / 99998 (department "09" doesn't exist), or genuinely new employees not
-- yet in employee_profiles.
