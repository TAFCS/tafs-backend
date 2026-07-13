-- insert-domestic-staff-2026-07.sql
--
-- Adds 8 domestic/support-staff employees found in the July 2026 HR intake
-- sheet ("1 - Employee Data") that were missing from employee_profiles.
-- They have no Attendance & Pay sheet row, so reporting_time, leaving_time,
-- late_relaxation_minutes, monthly_pay, campus_id, days_per_week are left
-- NULL pending HR follow-up.
--
-- Run step 1 and commit it BEFORE running steps 2-4 in the same session --
-- Postgres does not allow a newly added enum value to be used in the same
-- transaction that added it.

-- ============================================================
-- STEP 1: add SUPPORT_STAFF category (run + commit this first)
-- ============================================================
ALTER TYPE "StaffCategory" ADD VALUE IF NOT EXISTS 'SUPPORT_STAFF';


-- ============================================================
-- STEP 2: ensure designations exist
-- ============================================================
INSERT INTO designations (title, department_id)
SELECT 'PEON', NULL
WHERE NOT EXISTS (SELECT 1 FROM designations WHERE title = 'PEON');

INSERT INTO designations (title, department_id)
SELECT 'CARE TAKER', NULL
WHERE NOT EXISTS (SELECT 1 FROM designations WHERE title = 'CARE TAKER');


-- ============================================================
-- STEP 3: ensure staff_types exist
-- ============================================================
INSERT INTO staff_types (code, name, is_active)
VALUES ('peon', 'PEON', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO staff_types (code, name, is_active)
VALUES ('care_taker', 'CARE TAKER', true)
ON CONFLICT (code) DO NOTHING;


-- ============================================================
-- STEP 4: insert the 8 employees
-- ============================================================
INSERT INTO employee_profiles (
  employee_code, full_name, father_name, mother_name, cnic, date_of_birth,
  join_date, address, personal_phone, designation_id, staff_type_id,
  staff_category, department_id, reporting_time, leaving_time,
  late_relaxation_minutes, monthly_pay, campus_id, days_per_week
)
VALUES
(
  '04-005081', 'NUSTRAT RAHAT', 'VICTOR', 'HAMEEDA', '42201-4189737-0', '1985-08-07',
  '2026-05-26', 'HOUSE # B-153, SECTOR # 30, BHITAIYABAD, G-E-J, KARACHI', '0327-8451811',
  (SELECT id FROM designations WHERE title = 'PEON'),
  (SELECT id FROM staff_types WHERE code = 'peon'),
  'SUPPORT_STAFF', NULL, NULL, NULL, NULL, NULL, NULL, NULL
),
(
  '04-005052', 'HIDAYATULLAH', 'REHMAT ULLAH', 'MAI HIDAYAT', '45202-7941560-9', '2003-07-07',
  '2026-06-02', 'BLOCK # 09, RASHEDI GOTH, GULSHAN-E-IQBAL', '0305-2498629',
  (SELECT id FROM designations WHERE title = 'PEON'),
  (SELECT id FROM staff_types WHERE code = 'peon'),
  'SUPPORT_STAFF', NULL, NULL, NULL, NULL, NULL, NULL, NULL
),
(
  '04-00143', 'SHAFIQUE HUSSAIN', 'NAZIR AHMED KHAN', NULL, '31303-2452231-5', NULL,
  '2011-09-29', 'HUSSAIN HAZARA GOTH MODEL YELEG NEAR METRO SHOPPING CENTRE B-11, L-61 GULSHAN-E-IQBAL', '0305-3376459',
  (SELECT id FROM designations WHERE title = 'CARE TAKER'),
  (SELECT id FROM staff_types WHERE code = 'care_taker'),
  'SUPPORT_STAFF', NULL, NULL, NULL, NULL, NULL, NULL, NULL
),
(
  '04-00151', 'SAQLAIN ABBAS', 'WAZIR HUSSAIN', NULL, '31303-2442897-7', NULL,
  '2011-10-06', 'HOUSE# L-131, BLOCK-11, HUSSAIN HAZARA GOTH METRO SHOPPING CENTRE GULSHAN-E-IQBAL, KARACHI', '0303-2568080',
  (SELECT id FROM designations WHERE title = 'CARE TAKER'),
  (SELECT id FROM staff_types WHERE code = 'care_taker'),
  'SUPPORT_STAFF', NULL, NULL, NULL, NULL, NULL, NULL, NULL
),
(
  '04-0050115', 'TAJ MUHAMMAD', 'EID O HASAN', 'NOOR BAI', '42501-0665674-3', '2001-01-01',
  '2026-06-03', 'BLOCK # 09, RASHEDI GOTH, GULSHAN-E-IQBAL', '0337-3473292',
  (SELECT id FROM designations WHERE title = 'PEON'),
  (SELECT id FROM staff_types WHERE code = 'peon'),
  'SUPPORT_STAFF', NULL, NULL, NULL, NULL, NULL, NULL, NULL
),
(
  '04-0050110', 'HASSAN RAZA', 'SABZAL', 'KANEEZ BIBI', '31303-3229120-3', '2003-01-07',
  '2026-03-24', 'BLOCK # 11, HAZARAGOTH, GULSHAN-E-IQBAL', '0318-176142',
  (SELECT id FROM designations WHERE title = 'PEON'),
  (SELECT id FROM staff_types WHERE code = 'peon'),
  'SUPPORT_STAFF', NULL, NULL, NULL, NULL, NULL, NULL, NULL
),
(
  '04-0050116', 'MUHAMMAD ARIF', 'MUHAMMAD KALU', 'MAQSOOD BIBI', '31301-9850550-1', '1998-01-01',
  '2026-01-06', 'C-155, KALANDARBAD, BLOCK # 10, GULSHAN-E-JOHAR', '0306-2703235',
  (SELECT id FROM designations WHERE title = 'CARE TAKER'),
  (SELECT id FROM staff_types WHERE code = 'care_taker'),
  'SUPPORT_STAFF', NULL, NULL, NULL, NULL, NULL, NULL, NULL
),
(
  '04-0050113', 'ZEESHAN ABBAS', 'GHULAM ABBAS', 'SUFAI MAI', '31303-2752937-3', '1997-01-07',
  '2026-04-27', 'BLOCK # 11, HAZARAGOTH, GULSHAN-E-IQBAL', '0370-3589496',
  (SELECT id FROM designations WHERE title = 'PEON'),
  (SELECT id FROM staff_types WHERE code = 'peon'),
  'SUPPORT_STAFF', NULL, NULL, NULL, NULL, NULL, NULL, NULL
)
ON CONFLICT (employee_code) DO NOTHING;