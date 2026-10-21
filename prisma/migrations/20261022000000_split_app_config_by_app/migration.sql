-- Migrate current app_config values to staff and parent keys
-- Parent app configs
INSERT INTO "app_config" ("key", "value", "description", "updated_at", "updated_by")
VALUES
  ('parent_min_android_build', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'min_android_build'), '9'), 'Minimum Android build required for Parent app', NOW(), 'MIGRATION'),
  ('parent_min_ios_build', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'min_ios_build'), '2'), 'Minimum iOS build required for Parent app', NOW(), 'MIGRATION'),
  ('parent_android_store_url', 'https://play.google.com/store/apps/details?id=com.tafs.app', 'Android Play Store URL for Parent app', NOW(), 'MIGRATION'),
  ('parent_ios_store_url', 'https://apps.apple.com/app/id6572338575', 'iOS App Store URL for Parent app', NOW(), 'MIGRATION'),
  ('parent_maintenance_mode', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'maintenance_mode'), 'false'), 'Maintenance mode active for Parent app', NOW(), 'MIGRATION'),
  ('parent_maintenance_message', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'maintenance_message'), 'The app is currently under maintenance. Please try again later.'), 'Maintenance message for Parent app', NOW(), 'MIGRATION'),
  -- Staff app configs
  ('staff_min_android_build', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'min_android_build'), '9'), 'Minimum Android build required for Staff app', NOW(), 'MIGRATION'),
  ('staff_min_ios_build', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'min_ios_build'), '2'), 'Minimum iOS build required for Staff app', NOW(), 'MIGRATION'),
  ('staff_android_store_url', 'https://play.google.com/store/apps/details?id=com.tafsstaff.app', 'Android Play Store URL for Staff app', NOW(), 'MIGRATION'),
  ('staff_ios_store_url', 'https://apps.apple.com/app/id6572338575', 'iOS App Store URL for Staff app', NOW(), 'MIGRATION'),
  ('staff_maintenance_mode', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'maintenance_mode'), 'false'), 'Maintenance mode active for Staff app', NOW(), 'MIGRATION'),
  ('staff_maintenance_message', COALESCE((SELECT "value" FROM "app_config" WHERE "key" = 'maintenance_message'), 'The app is currently under maintenance. Please try again later.'), 'Maintenance message for Staff app', NOW(), 'MIGRATION')
ON CONFLICT ("key") DO UPDATE SET
  "value" = EXCLUDED."value",
  "updated_at" = NOW(),
  "updated_by" = 'MIGRATION'
WHERE "app_config"."value" IN ('https://play.google.com/store', 'https://apps.apple.com/store');
