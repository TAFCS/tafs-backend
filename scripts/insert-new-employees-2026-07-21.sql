-- insert-new-employees-2026-07-21.sql
--
-- 16 new employees found in TAFS_HR_Employee_Intake-2.xlsx that aren't yet in
-- employee_profiles (diffed against the employee list captured from the prior
-- intake read). All are from either the new "GKF" (Gulshan Kaneez Fatima,
-- campus KNF) teaching batch or the "TAFSAL" (org-wide support/facilities,
-- no single campus) batch of guards/electricians/maids.
--
-- Categorization follows the SAME logic as scripts/staff-org-mapping.ts
-- (job_title free text + staff_category enum + department_id FK — NOT
-- designation_id/staff_type_id, which the real bulk-import path always
-- leaves null). Two categories/departments don't exist among the app's
-- normal 11 StaffCategory values / 5 DEPARTMENT_SEED departments — support
-- staff (guard/electrician/maid) — so this reuses the SUPPORT_STAFF enum
-- value added in 20260713120000_add_support_staff_category and adds one new
-- department, "SUPPORT SERVICES", parallel to the existing 5.
--
-- Campus mapping used: "Johar C-II/III/IV" -> JHR (id 1), "GKF" -> KNF (id 2,
-- Kaneez Fatima Campus), "BUI NNN" -> NNZ (id 3, North Nazimabad Campus),
-- "TAFSAL" -> NULL (not tied to one campus — matches how the 8 domestic
-- staff added earlier this month were also left campus_id NULL).
--
-- Names are inserted with honorific prefixes (MRS./MR./MS.) already stripped,
-- to stay consistent with strip-name-honorifics.sql being run DB-wide.
--
-- FLAGGED — do not treat these as resolved without checking the source sheet:
--   1. All 8 "GKF ..." teacher rows have Leaving Time = 02:30 in the sheet,
--      with Reporting Time = 07:30. That's a ~19hr shift if taken literally;
--      almost certainly meant 14:30 (2:30 PM) and mistyped without AM/PM into
--      a 12-hour-formatted cell. Inserted here AS-IS (02:30) — confirm with
--      HR and correct if wrong, since it'll affect late/attendance logic.
--   2. 02-001481 (BENAZIR WASEEM, HOME TEACHER KG) is tagged campus "TAFSAL"
--      in the sheet, which is odd for a KG classroom teacher — TAFSAL is
--      otherwise only used for guards/electricians/maids/senior admin.
--      Inserted with campus_id NULL per the TAFSAL convention; likely a
--      sheet data-entry mistake and should probably be GKF/KNF instead.
--   3. 02-001481's CNIC "42201-725510-2" is one digit short (12 digits, not
--      13) — inserted as NULL rather than guessing the missing digit.
--   4. 02-00020 (ASBAH BATOOL) has an implausible DOB (2026-01-08, i.e. a
--      newborn) and an oddly old join_date (2005-11-27) that predates the
--      company's other records by decades — both look like a row/column
--      mix-up in the sheet. Both inserted as NULL pending correction. Her
--      CNIC ("42201-69756388") was just missing its second dash — a safe,
--      unambiguous fix — reinserted here as "42201-6975638-8".
--
-- 15 OTHER new-looking rows in the sheet are excluded entirely: their
-- Employee Code cell got auto-converted by Excel into a date (e.g.
-- "1940-02-01 00:00:00") because whatever was typed looked date-like. The
-- original typed code is not recoverable from the file — those rows need
-- the Employee Code column fixed at the source before they can be imported.
-- Affected names: MR. ALI ASGHAR MIRZA, MS. AYESHA, MS. MUQADDAS JABIN,
-- MS. FOZIA NIGHAT, MS. MEHAK MUBASHIRA, MS. AIMAN IMRAN, MS. JAVAIRA
-- SHAHZAD, MS. SAMREEN IRFAN (all tagged "BUI NNN" — North Nazimabad
-- teachers), plus MUHAMMAD HUSSAIN MIRZA, SHOAIB ISMAIL, SONIA CINDERILLA,
-- MRS. FATIMA HUSSAIN, MRS. FOZIA HUSSAIN, MRS. ASIFA OWAIS, M. SOHAIL KHAN
-- (these last 7 already existed with the same corrupted-date codes in the
-- prior intake file too, so they're not new — just still broken).


-- ============================================================
-- STEP 1: ensure departments exist (5 standard + 1 new)
-- ============================================================
INSERT INTO departments (name, description)
SELECT 'ACADEMICS', 'Teachers + academic admin/coordinators + campus principals/headmistresses'
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'ACADEMICS');

INSERT INTO departments (name, description)
SELECT 'SENIOR MANAGEMENT', 'CEO, MD, group Directresses, Deputy Directress'
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'SENIOR MANAGEMENT');

INSERT INTO departments (name, description)
SELECT 'FINANCE', 'Directress Finance, Accounts/VAN Coordinator'
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'FINANCE');

INSERT INTO departments (name, description)
SELECT 'IT & TECHNOLOGY', 'IT Manager, Computer Operators, Graphic Designers'
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'IT & TECHNOLOGY');

INSERT INTO departments (name, description)
SELECT 'ADMINISTRATION', 'Office Assistants, FDOs, Admin Assistants, Outdoor Rider'
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'ADMINISTRATION');

INSERT INTO departments (name, description)
SELECT 'SUPPORT SERVICES', 'Peons, care takers, guards, electricians, maids, drivers — facilities & domestic support staff'
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'SUPPORT SERVICES');


-- ============================================================
-- STEP 2 (optional but recommended): backfill department_id on the 8
-- domestic-staff employees inserted 2026-07-13, so they're consistent with
-- the new SUPPORT SERVICES department instead of being left NULL.
-- ============================================================
UPDATE employee_profiles
SET department_id = (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES')
WHERE staff_category = 'SUPPORT_STAFF'
  AND department_id IS NULL;


-- ============================================================
-- STEP 3: insert the 16 new employees
-- ============================================================
INSERT INTO employee_profiles (
  employee_code, full_name, father_name, mother_name, cnic, date_of_birth,
  join_date, address, personal_phone, job_title, staff_category,
  department_id, campus_id, designation_id, staff_type_id,
  reporting_time, leaving_time, late_relaxation_minutes, monthly_pay, days_per_week
)
VALUES
(
  '02-00010', 'ALISHBA AHMED', 'SAEED AHMED', 'SADIA SAEED', '42501-6670452-8', '2003-05-23',
  '2025-09-01', 'D-75, RUFI SPRING FLOWER, G-E-H, SCHEME 33', '0332-2341721',
  'CO-TEACHER', 'ASSISTANT_TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 2, NULL, NULL,
  '07:30', '02:30', 5, 25000, NULL
),
(
  '02-00011', 'AMBREEN UZAIR', 'ABDUL RASHID', 'ANJUM PERVEEN', '42101-0544039-6', NULL,
  '2025-09-15', 'B-5, KANEEZ FATIMA SOCIETY, BL - 2', '0306-2175766',
  'HOME TEACHER KG', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 2, NULL, NULL,
  '07:30', '02:30', 5, 27000, NULL
),
(
  '02-00014', 'HUSNIA RAHEEM', 'ABDUL RAHEEM', 'ZARMINE', '42201-9103653-2', '1994-07-16',
  '2025-09-19', 'MALIK CO-OPERATION SOCIETY', '0334-3199480',
  'JUNIOR TEACHER', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 2, NULL, NULL,
  '07:30', '02:30', 5, 27000, NULL
),
(
  '02-00015', 'SANA BATOOL', 'BAKHTIAR AHMED', 'UZMA BAKHTIAR', '42201-0912719-4', '2002-04-24',
  '2025-10-16', 'KANEEZ FATIMA SOCIETY, BL - 01', '0336-2357511',
  'JUNIOR''S SCIENCE TEACHER', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 2, NULL, NULL,
  '07:30', '02:30', 5, 30000, NULL
),
(
  '02-00018', 'ATIQA SAEED', 'SAEED ALI', 'ZOHRA SAEED', '71703-0569502-0', '2002-08-25',
  '2025-10-30', 'AWAN-E-LIAQUAT GIRLS HOSTEL, UNIVERSITY OF KARACHI (KU)', '0355-5364328',
  'JUNIOR TEACHER', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 2, NULL, NULL,
  '07:30', '02:30', 5, 27000, NULL
),
(
  '02-00019', 'SYEDA RUBAB NAQVI', 'SYED MUJAHID HUSSAIN NAQVI', 'SHAISTA PARVEEN', '42201-5184279-8', '1988-08-08',
  '2026-01-05', 'Hno L1801 block 1 kaniz Fatima society Gulzar e hijri scheme 33 Karachi', '0321-3389700',
  'HOME TEACHER P.N', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 2, NULL, NULL,
  '07:30', '02:30', 5, 40000, NULL
),
(
  '02-00020', 'ASBAH BATOOL', 'BAKHTIAR AHMED', 'UZMA BAKHTIAR', '42201-6975638-8', NULL,
  NULL, 'KANEEZ FATIMA SOCIETY, BL - 01', '0336-2357511',
  'CO-TEACHER', 'ASSISTANT_TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), 2, NULL, NULL,
  '07:30', '02:30', 5, 25000, NULL
),
(
  '02-001481', 'BENAZIR WASEEM', 'AGHA WASEEM', 'ANILA FATIMA', NULL, '2009-05-14',
  '2026-07-15', 'RIZWA SOCIETY SAFORA CHOWRANGI', '0315-8958912',
  'HOME TEACHER KG', 'TEACHER',
  (SELECT id FROM departments WHERE name = 'ACADEMICS'), NULL, NULL, NULL,
  '07:30', '02:30', 5, 35000, NULL
),
(
  '04-0050118', 'SHAKEELA', NULL, NULL, NULL, NULL,
  '2022-01-28', NULL, NULL,
  'MAID', 'SUPPORT_STAFF',
  (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES'), 2, NULL, NULL,
  '07:00', '10:00', 5, 37380, NULL
),
(
  '04-005051', 'TASLEEEM', NULL, NULL, NULL, NULL,
  '2024-11-01', NULL, NULL,
  'MAID', 'SUPPORT_STAFF',
  (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES'), 2, NULL, NULL,
  '09:00', '07:00', 5, 25000, NULL
),
(
  '04-005062', 'AZRA RIAZ', NULL, NULL, NULL, NULL,
  '2025-01-27', NULL, NULL,
  'MAID', 'SUPPORT_STAFF',
  (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES'), 2, NULL, NULL,
  '07:00', '16:30', 5, 22500, NULL
),
(
  '06-00562', 'ALI HAIDER', 'MUHAMMAD HAROON', NULL, '42201-2567093-9', NULL,
  '2025-11-10', NULL, '0334-0229433',
  'ELECTRICIAN', 'SUPPORT_STAFF',
  (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES'), NULL, NULL, NULL,
  '07:00', '16:30', 5, 15000, NULL
),
(
  '06-00564', 'SALEEM ULLAH', 'ABDUL HAMEED', NULL, '45204-2115422-1', NULL,
  '2025-01-12', NULL, NULL,
  'GUARD', 'SUPPORT_STAFF',
  (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES'), NULL, NULL, NULL,
  '07:00', '16:30', 5, 30000, NULL
),
(
  '06-00572', 'GHULAM HAIDER', 'WAHID ALI', NULL, '32402-2143723-7', NULL,
  '2026-03-03', NULL, NULL,
  'GUARD', 'SUPPORT_STAFF',
  (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES'), NULL, NULL, NULL,
  '07:00', '16:30', 5, 30000, NULL
),
(
  '06-00573', 'ABID HUSSAIN KHUSA', 'LASHARI LHAN', NULL, '32402-4326444-1', NULL,
  '2026-03-28', NULL, NULL,
  'GUARD', 'SUPPORT_STAFF',
  (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES'), NULL, NULL, NULL,
  '07:00', '16:30', 5, 30000, NULL
),
(
  '06-00575', 'MUHAMMAD AHMED', 'SANOBER KHAN', NULL, '42201-0260452-1', '1989-05-20',
  '2026-07-07', 'A-175, 2-B LANHI AREA, KARACHI', NULL,
  'ELECTRICIAN', 'SUPPORT_STAFF',
  (SELECT id FROM departments WHERE name = 'SUPPORT SERVICES'), NULL, NULL, NULL,
  '07:00', '16:30', 5, 45000, NULL
)
ON CONFLICT (employee_code) DO NOTHING;
