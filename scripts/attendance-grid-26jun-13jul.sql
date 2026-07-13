-- attendance-grid-26jun-13jul.sql
--
-- Employee attendance grid, 26 June 2026 - 13 July 2026.
-- Rows: employees (mapped, from employee_profiles), THEN unmapped ZK device
-- pins (raw scans with no employee/student link yet) as trailing rows.
-- Columns: employee code, name, staff category, designation, staff type,
-- then one column per date showing "check_in-check_out" (24hr HH:MM),
-- blank if no attendance/scan record for that date.
--
-- Unmapped rows mirror the logic of ZkAttendanceMappingService.getUnmappedPins():
-- zk_attendance_scans where person_type IS NULL, joined to zk_pin_name_hints
-- for a suggested display name. "Employee Code" for these rows is the raw
-- "device_sn:device_pin", and each day cell is the earliest/latest raw scan
-- time that date (not a processed check_in_at/check_out_at, since these
-- were never resolved into attendance_staff_daily).
--
-- Export straight to CSV:
--   psql "<connection string>" -c "\copy (<paste this whole SELECT>) TO 'attendance_grid_26jun_13jul.csv' WITH CSV HEADER"
-- Or run in any SQL client and export the result grid.

SELECT
  "Employee Code", "Name", "Staff Category", "Designation", "Staff Type",
  "26-Jun (Fri)", "27-Jun (Sat)", "28-Jun (Sun)", "29-Jun (Mon)", "30-Jun (Tue)",
  "01-Jul (Wed)", "02-Jul (Thu)", "03-Jul (Fri)", "04-Jul (Sat)", "05-Jul (Sun)",
  "06-Jul (Mon)", "07-Jul (Tue)", "08-Jul (Wed)", "09-Jul (Thu)", "10-Jul (Fri)",
  "11-Jul (Sat)", "12-Jul (Sun)", "13-Jul (Mon)"
FROM (

  -- ============================================================
  -- Block 1: mapped employees
  -- ============================================================
  SELECT
    0 AS sort_group,
    ep.employee_code                                    AS "Employee Code",
    ep.full_name                                         AS "Name",
    ep.staff_category::text                              AS "Staff Category",
    d.title                                              AS "Designation",
    st.name                                               AS "Staff Type",
    MAX(CASE WHEN a.date = '2026-06-26' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "26-Jun (Fri)",
    MAX(CASE WHEN a.date = '2026-06-27' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "27-Jun (Sat)",
    MAX(CASE WHEN a.date = '2026-06-28' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "28-Jun (Sun)",
    MAX(CASE WHEN a.date = '2026-06-29' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "29-Jun (Mon)",
    MAX(CASE WHEN a.date = '2026-06-30' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "30-Jun (Tue)",
    MAX(CASE WHEN a.date = '2026-07-01' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "01-Jul (Wed)",
    MAX(CASE WHEN a.date = '2026-07-02' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "02-Jul (Thu)",
    MAX(CASE WHEN a.date = '2026-07-03' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "03-Jul (Fri)",
    MAX(CASE WHEN a.date = '2026-07-04' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "04-Jul (Sat)",
    MAX(CASE WHEN a.date = '2026-07-05' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "05-Jul (Sun)",
    MAX(CASE WHEN a.date = '2026-07-06' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "06-Jul (Mon)",
    MAX(CASE WHEN a.date = '2026-07-07' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "07-Jul (Tue)",
    MAX(CASE WHEN a.date = '2026-07-08' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "08-Jul (Wed)",
    MAX(CASE WHEN a.date = '2026-07-09' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "09-Jul (Thu)",
    MAX(CASE WHEN a.date = '2026-07-10' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "10-Jul (Fri)",
    MAX(CASE WHEN a.date = '2026-07-11' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "11-Jul (Sat)",
    MAX(CASE WHEN a.date = '2026-07-12' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "12-Jul (Sun)",
    MAX(CASE WHEN a.date = '2026-07-13' THEN
      COALESCE(to_char(a.check_in_at, 'HH24:MI'), '') || CASE WHEN a.check_in_at IS NOT NULL OR a.check_out_at IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(a.check_out_at, 'HH24:MI'), '')
    END) AS "13-Jul (Mon)"
  FROM employee_profiles ep
  LEFT JOIN designations d ON d.id = ep.designation_id
  LEFT JOIN staff_types st ON st.id = ep.staff_type_id
  LEFT JOIN attendance_staff_daily a
    ON a.employee_id = ep.id
    AND a.date BETWEEN '2026-06-26' AND '2026-07-13'
  GROUP BY ep.id, ep.employee_code, ep.full_name, ep.staff_category, d.title, st.name

  UNION ALL

  -- ============================================================
  -- Block 2: unmapped ZK device pins (person_type IS NULL)
  -- ============================================================
  SELECT
    1 AS sort_group,
    s.device_sn || ':' || s.device_pin                  AS "Employee Code",
    h.suggested_name                                     AS "Name",
    NULL                                                  AS "Staff Category",
    NULL                                                  AS "Designation",
    NULL                                                  AS "Staff Type",
    MAX(CASE WHEN s.attendance_date = '2026-06-26' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "26-Jun (Fri)",
    MAX(CASE WHEN s.attendance_date = '2026-06-27' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "27-Jun (Sat)",
    MAX(CASE WHEN s.attendance_date = '2026-06-28' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "28-Jun (Sun)",
    MAX(CASE WHEN s.attendance_date = '2026-06-29' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "29-Jun (Mon)",
    MAX(CASE WHEN s.attendance_date = '2026-06-30' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "30-Jun (Tue)",
    MAX(CASE WHEN s.attendance_date = '2026-07-01' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "01-Jul (Wed)",
    MAX(CASE WHEN s.attendance_date = '2026-07-02' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "02-Jul (Thu)",
    MAX(CASE WHEN s.attendance_date = '2026-07-03' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "03-Jul (Fri)",
    MAX(CASE WHEN s.attendance_date = '2026-07-04' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "04-Jul (Sat)",
    MAX(CASE WHEN s.attendance_date = '2026-07-05' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "05-Jul (Sun)",
    MAX(CASE WHEN s.attendance_date = '2026-07-06' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "06-Jul (Mon)",
    MAX(CASE WHEN s.attendance_date = '2026-07-07' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "07-Jul (Tue)",
    MAX(CASE WHEN s.attendance_date = '2026-07-08' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "08-Jul (Wed)",
    MAX(CASE WHEN s.attendance_date = '2026-07-09' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "09-Jul (Thu)",
    MAX(CASE WHEN s.attendance_date = '2026-07-10' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "10-Jul (Fri)",
    MAX(CASE WHEN s.attendance_date = '2026-07-11' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "11-Jul (Sat)",
    MAX(CASE WHEN s.attendance_date = '2026-07-12' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "12-Jul (Sun)",
    MAX(CASE WHEN s.attendance_date = '2026-07-13' THEN
      COALESCE(to_char(s.min_scan, 'HH24:MI'), '') || CASE WHEN s.min_scan IS NOT NULL OR s.max_scan IS NOT NULL THEN '-' ELSE '' END || COALESCE(to_char(s.max_scan, 'HH24:MI'), '')
    END) AS "13-Jul (Mon)"
  FROM (
    SELECT device_sn, device_pin, attendance_date, MIN(scan_time) AS min_scan, MAX(scan_time) AS max_scan
    FROM zk_attendance_scans
    WHERE person_type IS NULL
      AND attendance_date BETWEEN '2026-06-26' AND '2026-07-13'
    GROUP BY device_sn, device_pin, attendance_date
  ) s
  LEFT JOIN zk_pin_name_hints h
    ON h.device_sn = s.device_sn AND h.device_pin = s.device_pin
  GROUP BY s.device_sn, s.device_pin, h.suggested_name

) combined
ORDER BY sort_group, "Employee Code";
