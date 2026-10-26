-- Seed canonical app_config rows and ensure real store URLs
INSERT INTO "app_config" ("key", "value", "description", "updated_at", "updated_by")
VALUES
  -- Parent app configurations
  ('parent_min_android_build', '9', 'Minimum Android build number required for Parent app', NOW(), 'MIGRATION'),
  ('parent_latest_android_build', '9', 'Latest Android build number available for Parent app', NOW(), 'MIGRATION'),
  ('parent_min_ios_build', '2', 'Minimum iOS build number required for Parent app', NOW(), 'MIGRATION'),
  ('parent_latest_ios_build', '2', 'Latest iOS build number available for Parent app', NOW(), 'MIGRATION'),
  ('parent_android_store_url', 'https://play.google.com/store/apps/details?id=com.tafs.app', 'Parent Android Play Store listing URL', NOW(), 'MIGRATION'),
  ('parent_ios_store_url', 'https://apps.apple.com/app/id6572338575', 'Parent iOS App Store listing URL', NOW(), 'MIGRATION'),
  ('parent_force_update_message', 'A new version of the app is available with critical improvements and new features. Please update to continue.', 'Force update message shown when build is below minimum', NOW(), 'MIGRATION'),
  ('parent_update_prompt_message', 'A new version of the Parent app is available with improvements and bug fixes. Would you like to update now?', 'Dismissible prompt message when build is below latest', NOW(), 'MIGRATION'),
  ('parent_maintenance_mode', 'false', 'Whether maintenance mode is active for Parent app', NOW(), 'MIGRATION'),
  ('parent_maintenance_message', 'The parent app is currently under maintenance. Please try again later.', 'Maintenance message shown to parents', NOW(), 'MIGRATION'),
  ('parent_maintenance_start', '', 'Scheduled maintenance start ISO timestamp for Parent app', NOW(), 'MIGRATION'),
  ('parent_maintenance_end', '', 'Scheduled maintenance end ISO timestamp for Parent app', NOW(), 'MIGRATION'),

  -- Staff app configurations
  ('staff_min_android_build', '9', 'Minimum Android build number required for Staff app', NOW(), 'MIGRATION'),
  ('staff_latest_android_build', '9', 'Latest Android build number available for Staff app', NOW(), 'MIGRATION'),
  ('staff_min_ios_build', '2', 'Minimum iOS build number required for Staff app', NOW(), 'MIGRATION'),
  ('staff_latest_ios_build', '2', 'Latest iOS build number available for Staff app', NOW(), 'MIGRATION'),
  ('staff_android_store_url', 'https://play.google.com/store/apps/details?id=com.tafsstaff.app', 'Staff Android Play Store listing URL', NOW(), 'MIGRATION'),
  ('staff_ios_store_url', 'https://apps.apple.com/app/id6572338575', 'Staff iOS App Store listing URL', NOW(), 'MIGRATION'),
  ('staff_force_update_message', 'A new version of the app is available with critical improvements and new features. Please update to continue.', 'Force update message shown when build is below minimum', NOW(), 'MIGRATION'),
  ('staff_update_prompt_message', 'A new version of the Staff app is available with improvements and bug fixes. Would you like to update now?', 'Dismissible prompt message when build is below latest', NOW(), 'MIGRATION'),
  ('staff_maintenance_mode', 'false', 'Whether maintenance mode is active for Staff app', NOW(), 'MIGRATION'),
  ('staff_maintenance_message', 'The staff app is currently under maintenance. Please try again later.', 'Maintenance message shown to staff', NOW(), 'MIGRATION'),
  ('staff_maintenance_start', '', 'Scheduled maintenance start ISO timestamp for Staff app', NOW(), 'MIGRATION'),
  ('staff_maintenance_end', '', 'Scheduled maintenance end ISO timestamp for Staff app', NOW(), 'MIGRATION'),

  -- Legacy global keys
  ('min_android_build', '9', 'Legacy: Minimum Android build number required', NOW(), 'MIGRATION'),
  ('min_ios_build', '2', 'Legacy: Minimum iOS build number required', NOW(), 'MIGRATION'),
  ('android_store_url', 'https://play.google.com/store/apps/details?id=com.tafs.app', 'Legacy: Android Play Store URL', NOW(), 'MIGRATION'),
  ('ios_store_url', 'https://apps.apple.com/app/id6572338575', 'Legacy: iOS App Store URL', NOW(), 'MIGRATION'),
  ('maintenance_mode', 'false', 'Legacy: Whether maintenance mode is active', NOW(), 'MIGRATION'),
  ('maintenance_message', 'The app is currently under maintenance. Please try again later.', 'Legacy: Message shown to users', NOW(), 'MIGRATION'),

  -- Developer settings switches
  ('pay_immediately_enabled', 'false', 'Enforce 4-day due date and PAY IMMEDIATELY watermark for 2+ arrears', NOW(), 'MIGRATION'),
  ('attendance_same_day_override_cutoff', '15:00', 'Same-day override cutoff time in HH:MM', NOW(), 'MIGRATION'),
  ('slc_last_number', '250', 'Last issued School Leaving Certificate number', NOW(), 'MIGRATION')
ON CONFLICT ("key") DO NOTHING;

-- Update any placeholder store URLs to real listing deep links
UPDATE "app_config"
SET "value" = 'https://play.google.com/store/apps/details?id=com.tafsstaff.app',
    "updated_at" = NOW(),
    "updated_by" = 'MIGRATION'
WHERE "key" = 'staff_android_store_url'
  AND ("value" IS NULL OR "value" = '' OR "value" IN ('https://play.google.com/store', 'https://play.google.com', 'https://play.google.com/store/apps'));

UPDATE "app_config"
SET "value" = 'https://play.google.com/store/apps/details?id=com.tafs.app',
    "updated_at" = NOW(),
    "updated_by" = 'MIGRATION'
WHERE "key" IN ('parent_android_store_url', 'android_store_url')
  AND ("value" IS NULL OR "value" = '' OR "value" IN ('https://play.google.com/store', 'https://play.google.com', 'https://play.google.com/store/apps'));

UPDATE "app_config"
SET "value" = 'https://apps.apple.com/app/id6572338575',
    "updated_at" = NOW(),
    "updated_by" = 'MIGRATION'
WHERE "key" IN ('staff_ios_store_url', 'parent_ios_store_url', 'ios_store_url')
  AND ("value" IS NULL OR "value" = '' OR "value" IN ('https://apps.apple.com/store', 'https://apps.apple.com'));
