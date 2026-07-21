-- insert-new-employees-buinnn-2026-07-21.sql
--
-- The 7 "BUI NNN" (North Nazimabad) teachers from
-- insert-new-employees-2026-07-21.sql that were excluded because Excel had
-- auto-converted their Employee Code into a date. User supplied the real
-- codes directly, confirming the corruption pattern: "02-1940" (dept 02,
-- number 1940) got misread as month=02/year=1940, day defaulted to 1 ->
-- "1940-02-01". All 7 codes below were reconstructed the same way and
-- verified against the corrupted dates seen earlier.
--
-- Same conventions as insert-new-employees-2026-07-21.sql: job_title is the
-- designation with the "BUI NNN " campus prefix stripped; designation_id/
-- staff_type_id left NULL (real app path doesn't use them); campus_id = 3
-- (NNZ, North Nazimabad Campus, per "BUI NNN means North Nazimabad Campus");
-- names inserted with MS./MRS./MR. prefix already stripped.
--
-- FLAGGED: same Leaving Time = 02:30 vs Reporting 07:30 anomaly as the GKF
-- batch — inserted as-is, confirm with HR whether it should be 14:30.
--
-- ACADEMICS department already exists in the live DB (id 6 per the
-- /api/v1/hr/departments check) — referenced here by name via subquery,
-- nothing to seed.

INSERT INTO employee_profiles (
  employee_code, full_name, father_name, mother_name, cnic, date_of_birth,
  join_date, address, personal_phone, job_title, staff_category,
  department_id, campus_id, designation_id, staff_type_id,
  reporting_time, leaving_time, late_relaxation_minutes, monthly_pay, days_per_week
)
VALUES
(
  '02-1940', 'AYESHA', 'M. ABDUL SAGHEER', 'SABA', '42000-1865181-4', '2002-11-14',
  '2023-10-02', 'HOUSE NUMBER C1/15 BLOCK A NORTH NAZIMABAD KARACHI', '0334-2423481',
  'ENGLISH TEACHER JUNIORS', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 3, NULL, NULL,
  '07:30', '02:30', 5, 35000, NULL
),
(
  '02-1953', 'MUQADDAS JABIN', 'IRFAN ULLAH', 'ZARNIGAR', '42101-5322393-4', '1999-07-09',
  '2024-02-12', 'A 15, BLOCK ''I'', NEAR KHADIJA MARKET, NORTH NAZIMABAD', '0330-2490796',
  'SCIENCE, ISLAMIYAT & URDU', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 3, NULL, NULL,
  '07:30', '02:30', 5, 25000, NULL
),
(
  '02-1955', 'FOZIA NIGHAT', 'ARIF QAMAR ALVI', 'PERVEN', '42101-1700605-4', '1982-02-22',
  '2024-02-17', 'FLAT # B-15, BLESSING PLAZA, BLOCK - K, NORTH NAZIMABAD', '0334-3178172',
  'HOME TEACHER (JR. II)', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 3, NULL, NULL,
  '07:30', '02:30', 5, 25000, NULL
),
(
  '02-1966', 'MEHAK MUBASHIRA', 'MUBASHIR AHMED KHALID', 'ABIDA NASEEM', '42101-8761589-6', '2004-02-14',
  '2024-11-04', 'R-283 BLOCK15 FB AREA', '0319-8364843',
  'HOME TEACHER (JR. I)', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 3, NULL, NULL,
  '07:30', '02:30', 5, 30000, NULL
),
(
  '02-1967', 'AIMAN IMRAN', 'M. IMRAN', 'NOSHEEN', '42101-5919341-4', '2003-01-09',
  '2024-11-21', 'HOUSE # 156, SECTOR 3, NORTH KARACHI', '0312-2028706',
  'HOME TEACHER (PRE-NUR AND NUR)', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 3, NULL, NULL,
  '07:30', '02:30', 5, 27000, NULL
),
(
  '02-1970', 'JAVAIRA SHAHZAD', 'SYED TALIB NAUMAN', 'NEELOFER TALIB', '42101-1332520-2', '1982-03-20',
  '2025-08-28', 'FLAT # 204, AERO CLOCK TOWER, BL-L, NORTH NAZIMABAD', '0321-3686001',
  'MATHS JR. III-V, SOCIAL STUDIES, URDU', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 3, NULL, NULL,
  '07:30', '02:30', 5, 32000, NULL
),
(
  '02-1971', 'SAMREEN IRFAN', 'RANA BASHIR', 'HAFIZA BANO', '42101-1700297-6', '1982-12-11',
  '2025-08-29', 'HOUSE # 11 A5-E, MAIN M. SIDDIIQ BUILDING, PAPOSH', '0335-3248221',
  'HOME TEACHER KG', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 3, NULL, NULL,
  '07:30', '02:30', 5, 35000, NULL
)
ON CONFLICT (employee_code) DO NOTHING;
