-- Add latest_build, update prompt/force-update messages, and maintenance scheduling keys
INSERT INTO "app_config" ("key", "value", "description", "updated_at", "updated_by")
VALUES
  ('parent_latest_android_build', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'parent_min_android_build'), '9'), 'Latest Android build available for Parent app', NOW(), 'MIGRATION'),
  ('parent_latest_ios_build', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'parent_min_ios_build'), '2'), 'Latest iOS build available for Parent app', NOW(), 'MIGRATION'),
  ('parent_force_update_message', 'A new version of the app is available with critical improvements and new features. Please update to continue.', 'Force update message for Parent app', NOW(), 'MIGRATION'),
  ('parent_update_prompt_message', 'A new version of the Parent app is available with improvements and bug fixes. Would you like to update now?', 'Optional update prompt message for Parent app', NOW(), 'MIGRATION'),
  ('parent_maintenance_start', '', 'Scheduled maintenance start time for Parent app', NOW(), 'MIGRATION'),
  ('parent_maintenance_end', '', 'Scheduled maintenance end time for Parent app', NOW(), 'MIGRATION'),

  ('staff_latest_android_build', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'staff_min_android_build'), '9'), 'Latest Android build available for Staff app', NOW(), 'MIGRATION'),
  ('staff_latest_ios_build', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'staff_min_ios_build'), '2'), 'Latest iOS build available for Staff app', NOW(), 'MIGRATION'),
  ('staff_force_update_message', 'A new version of the app is available with critical improvements and new features. Please update to continue.', 'Force update message for Staff app', NOW(), 'MIGRATION'),
  ('staff_update_prompt_message', 'A new version of the Staff app is available with improvements and bug fixes. Would you like to update now?', 'Optional update prompt message for Staff app', NOW(), 'MIGRATION'),
  ('staff_maintenance_start', '', 'Scheduled maintenance start time for Staff app', NOW(), 'MIGRATION'),
  ('staff_maintenance_end', '', 'Scheduled maintenance end time for Staff app', NOW(), 'MIGRATION')
ON CONFLICT ("key") DO NOTHING;
