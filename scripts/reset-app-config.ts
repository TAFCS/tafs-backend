/**
 * Resets app_config to safe defaults after test plan execution (Phase cleanup).
 * Usage: npx ts-node scripts/reset-app-config.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SAFE_DEFAULTS: Record<string, string> = {
  // Parent
  parent_maintenance_mode: 'false',
  parent_maintenance_message: 'The app is currently under maintenance. Please try again later.',
  parent_min_android_build: '9',
  parent_min_ios_build: '2',
  parent_android_store_url: 'https://play.google.com/store/apps/details?id=com.tafs.app',
  parent_ios_store_url: 'https://apps.apple.com/app/id6572338575',

  // Staff
  staff_maintenance_mode: 'false',
  staff_maintenance_message: 'The app is currently under maintenance. Please try again later.',
  staff_min_android_build: '9',
  staff_min_ios_build: '2',
  staff_android_store_url: 'https://play.google.com/store/apps/details?id=com.tafsstaff.app',
  staff_ios_store_url: 'https://apps.apple.com/app/id6572338575',

  // Legacy fallback
  maintenance_mode: 'false',
  maintenance_message: 'The app is currently under maintenance. Please try again later.',
  min_android_build: '9',
  min_ios_build: '2',
  android_store_url: 'https://play.google.com/store/apps/details?id=com.tafs.app',
  ios_store_url: 'https://apps.apple.com/app/id6572338575',
};

async function main() {
  console.log('Resetting app_config to safe defaults...');

  for (const [key, value] of Object.entries(SAFE_DEFAULTS)) {
    await prisma.app_config.upsert({
      where: { key },
      update: { value, updated_by: 'TEST_CLEANUP' },
      create: { key, value, updated_by: 'TEST_CLEANUP', updated_at: new Date() },
    });
    console.log(`  ${key} = ${value}`);
  }

  console.log('Cleanup complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
