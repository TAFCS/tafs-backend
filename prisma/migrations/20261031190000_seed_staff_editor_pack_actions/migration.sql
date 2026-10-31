-- Seed sub-permissions for Staff Editor pack (3296545d-efb4-4688-94c2-c2f2eb6396de)
INSERT INTO "access_pack_tile_actions" ("pack_id", "tile_id", "action_id")
VALUES
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.directory', 'view'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.directory', 'identity.view'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.directory', 'identity.edit'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.directory', 'admissions.view'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.directory', 'admissions.edit'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.directory', 'academic.view'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.directory', 'academic.edit'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.directory', 'guardians.view'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.directory', 'guardians.edit'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.directory', 'status.change'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.registration', 'view'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.registration', 'register'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.registration', 'admission_form'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.quick_registration', 'view'),
  ('3296545d-efb4-4688-94c2-c2f2eb6396de', 'student.quick_registration', 'create')
ON CONFLICT ("pack_id", "tile_id", "action_id") DO NOTHING;
