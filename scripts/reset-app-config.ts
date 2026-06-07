/**
 * Resets app_config to safe defaults after test plan execution (Phase cleanup).
 * Usage: npx ts-node scripts/reset-app-config.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SAFE_DEFAULTS: Record<string, string> = {
  maintenance_mode: 'false',
  maintenance_message: 'The app is currently under maintenance. Please try again later.',
  min_android_build: '9',
  min_ios_build: '9',
  android_store_url: 'https://play.google.com/store',
  ios_store_url: 'https://apps.apple.com/store',
};

async function main() {
  console.log('Resetting app_config to safe defaults...');

  for (const [key, value] of Object.entries(SAFE_DEFAULTS)) {
    await prisma.app_config.upsert({
      where: { key },
      update: { value, updated_by: 'TEST_CLEANUP' },
      create: { key, value, updated_by: 'TEST_CLEANUP' },
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
