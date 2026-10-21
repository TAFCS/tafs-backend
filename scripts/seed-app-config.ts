import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const initialConfigs = [
  // Parent App Remote Configurations
  { key: 'parent_maintenance_mode', value: 'false', description: 'Whether maintenance mode is active for parent app' },
  { key: 'parent_maintenance_message', value: 'The parent app is currently under maintenance. Please try again later.', description: 'Maintenance message shown to parents' },
  { key: 'parent_min_android_build', value: '9', description: 'Minimum Android build number required for parent app' },
  { key: 'parent_min_ios_build', value: '2', description: 'Minimum iOS build number required for parent app' },
  { key: 'parent_android_store_url', value: 'https://play.google.com/store/apps/details?id=com.tafs.app', description: 'Parent Android Play Store listing URL' },
  { key: 'parent_ios_store_url', value: 'https://apps.apple.com/app/id6572338575', description: 'Parent iOS App Store listing URL' },

  // Staff App Remote Configurations
  { key: 'staff_maintenance_mode', value: 'false', description: 'Whether maintenance mode is active for staff app' },
  { key: 'staff_maintenance_message', value: 'The staff app is currently under maintenance. Please try again later.', description: 'Maintenance message shown to staff' },
  { key: 'staff_min_android_build', value: '9', description: 'Minimum Android build number required for staff app' },
  { key: 'staff_min_ios_build', value: '2', description: 'Minimum iOS build number required for staff app' },
  { key: 'staff_android_store_url', value: 'https://play.google.com/store/apps/details?id=com.tafsstaff.app', description: 'Staff Android Play Store listing URL' },
  { key: 'staff_ios_store_url', value: 'https://apps.apple.com/app/id6572338575', description: 'Staff iOS App Store listing URL' },

  // Legacy Global Keys (kept for fallback)
  { key: 'maintenance_mode', value: 'false', description: 'Legacy: Whether maintenance mode is active' },
  { key: 'maintenance_message', value: 'The app is currently under maintenance. Please try again later.', description: 'Legacy: Message shown to users' },
  { key: 'min_android_build', value: '9', description: 'Legacy: Minimum Android build number required' },
  { key: 'min_ios_build', value: '2', description: 'Legacy: Minimum iOS build number required' },
  { key: 'android_store_url', value: 'https://play.google.com/store/apps/details?id=com.tafs.app', description: 'Legacy: Android Play Store URL' },
  { key: 'ios_store_url', value: 'https://apps.apple.com/app/id6572338575', description: 'Legacy: iOS App Store URL' },

  {
    key: 'slc_last_number',
    value: '250',
    description: 'Last issued School Leaving Certificate (SLC) number. Next issued = this + 1.',
  },
  {
    key: 'pay_immediately_enabled',
    value: 'false',
    description: 'When true, a voucher issued to a student with 2+ months of arrears gets its due/validity dates forced to issue_date+4 and a PAY IMMEDIATELY watermark. Off by default until confirmed — see VouchersService.',
  },
];

async function main() {
  console.log('Seeding app_config...');

  for (const config of initialConfigs) {
    await prisma.app_config.upsert({
      where: { key: config.key },
      update: {},
      create: {
        key: config.key,
        value: config.value,
        description: config.description,
        updated_by: 'SEED',
        updated_at: new Date(),
      },
    });
  }

  console.log('app_config seeding complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
