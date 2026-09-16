-- TAFS Staff App tabs as grantable tiles, allowed for every employee.
--
-- Each permission-gated tab in the Staff App now has an access tile
-- (module `staff_app`, see tiles.manifest.ts), and all four ride on the
-- existing "Employee self-service" system pack, which is assigned to every
-- login linked to an employee profile. Being pack-granted (not written into
-- role_permissions) is what keeps it revocable per person from People &
-- Access: a tile deny beats a pack, it cannot beat a role baseline.
--
-- Idempotent throughout, and self-sufficient: it upserts the four
-- access_tiles rows itself so the pack FKs resolve even though AccessSync has
-- not booted the new manifest yet. AccessSync overwrites them identically.
--
-- MUST be applied before the code that ships staff_app tiles boots:
-- AccessSync refuses to boot on a manifest capability key missing from
-- `permissions`, and hr.timetable.self_view is new here.

-- 1. The one key the app already checks but the database never had.
INSERT INTO "permissions" ("key", "module", "description")
VALUES ('hr.timetable.self_view', 'HR & Attendance', 'View own timetable in the Staff App')
ON CONFLICT ("key") DO NOTHING;

-- 2. The tiles (mirrors TILES_MANIFEST; sort_order is rewritten on boot).
INSERT INTO "access_tiles" ("id", "module", "label", "description", "href", "group", "sort_order", "is_active")
VALUES
  ('staff_app.attendance', 'staff_app', 'Attendance',      'Own attendance calendar, day details and objections',     'staff-app://attendance', NULL, 900, true),
  ('staff_app.timetable',  'staff_app', 'Timetable',       'Own weekly class schedule',                               'staff-app://timetable',  NULL, 901, true),
  ('staff_app.payroll',    'staff_app', 'Payroll',         'Own payslips (also needs payroll enabled on the employee)', 'staff-app://payroll',  NULL, 902, true),
  ('staff_app.leave',      'staff_app', 'Apply for Leave', 'Submit and track own leave requests',                     'staff-app://leave',      NULL, 903, true)
ON CONFLICT ("id") DO UPDATE SET
  "module" = EXCLUDED."module",
  "label" = EXCLUDED."label",
  "description" = EXCLUDED."description",
  "href" = EXCLUDED."href",
  "is_active" = true;

-- 3. The pack. It already exists on the shared DB (scripts/seed-access.ts)
--    with no tiles, because no tile carried these keys until now.
INSERT INTO "access_packs" ("id", "name", "description", "is_system")
VALUES (gen_random_uuid()::text, 'Employee self-service', 'TAFS Staff App tabs every employee gets: attendance, timetable, payroll and leave', true)
ON CONFLICT ("name") DO UPDATE SET
  "description" = EXCLUDED."description",
  "is_system" = true;

INSERT INTO "access_pack_tiles" ("pack_id", "tile_id")
SELECT p."id", t."tile_id"
FROM "access_packs" p
CROSS JOIN (VALUES ('staff_app.attendance'), ('staff_app.timetable'), ('staff_app.payroll'), ('staff_app.leave')) AS t("tile_id")
WHERE p."name" = 'Employee self-service'
ON CONFLICT DO NOTHING;

-- 4. Backfill: every login linked to an employee profile.
INSERT INTO "user_access_packs" ("user_id", "pack_id", "assigned_by", "assigned_at")
SELECT DISTINCT ep."user_id", p."id",
  COALESCE(
    (SELECT "id" FROM "users" WHERE "id" = '00000000-0000-0000-0000-000000000001'),
    (SELECT "id" FROM "users" WHERE "role" = 'SUPER_ADMIN' ORDER BY "created_at" LIMIT 1)
  ),
  now()
FROM "employee_profiles" ep
JOIN "users" u ON u."id" = ep."user_id"
CROSS JOIN "access_packs" p
WHERE p."name" = 'Employee self-service'
ON CONFLICT ("user_id", "pack_id") DO NOTHING;
