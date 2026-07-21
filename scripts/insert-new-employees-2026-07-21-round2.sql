-- insert-new-employees-2026-07-21-round2.sql
--
-- TAFS_HR_Employee_Intake-3.xlsx re-encoded the 8 previously date-corrupted
-- Employee Code cells as plain text. Cross-checked all 8 against the
-- June 23 2026 SQL backup:
--
--   01-2000 MUHAMMAD HUSSAIN MIRZA, 01-2005 MRS. FATIMA HUSSAIN,
--   01-2006 MRS. FOZIA HUSSAIN, 01-2009 MRS. ASIFA OWAIS,
--   03-1937 MR. ALI ASGHAR MIRZA, 05-2011 M. SOHAIL KHAN
--
-- ...are ALL already in employee_profiles with these exact codes (confirmed
-- by name + job title match in the backup) — the corrupted code was purely
-- a spreadsheet artifact, not a DB gap. Nothing to insert for these 6.
--
-- The other 2 are NOT in the June 23 backup and are genuinely new hires
-- (both joined 2026-07-04, just over 2 weeks before this file was made):
--   04-2001 SHOAIB ISMAIL — "gkf peon"
--   04-2002 SONIA CINDERILLA — "gkf maid"
-- Both fit the same SUPPORT_STAFF / SUPPORT SERVICES / campus=GKF(KNF)
-- pattern as the earlier PEON/MAID batches, so this reuses those directly.
--
-- Run scripts/insert-new-employees-2026-07-21.sql first if you haven't —
-- this depends on the SUPPORT SERVICES department it creates.
--
-- Recommended: before treating the "6 already exist" conclusion as final,
-- spot check them live, since my backup is ~1 month old:
--   SELECT employee_code, full_name, job_title FROM employee_profiles
--   WHERE employee_code IN ('01-2000','01-2005','01-2006','01-2009','03-1937','05-2011');

INSERT INTO employee_profiles (
  employee_code, full_name, father_name, mother_name, cnic, date_of_birth,
  join_date, address, personal_phone, job_title, staff_category,
  department_id, campus_id, designation_id, staff_type_id,
  reporting_time, leaving_time, late_relaxation_minutes, monthly_pay, days_per_week
)
VALUES
(
  '04-2001', 'SHOAIB ISMAIL', 'ISMAIL', NULL, '44206-2933501-7', '2006-06-21',
  '2026-07-04', NULL, NULL,
  'PEON', 'SUPPORT_STAFF',
  (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES'), 2, NULL, NULL,
  '07:00', '16:30', 5, 30000, NULL
),
(
  '04-2002', 'SONIA CINDERILLA', 'YOUNUS JAMES', 'SUFAI MAI', '42301-7490572-8', '2002-03-11',
  '2026-07-04', 'HOUSE # 16126, NIPA BRICK IQBAL LINE, FC AREA, CLIFTON CANT, KARACHI', NULL,
  'MAID', 'SUPPORT_STAFF',
  (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES'), 2, NULL, NULL,
  '07:00', '16:30', 5, 30000, NULL
)
ON CONFLICT (employee_code) DO NOTHING;
