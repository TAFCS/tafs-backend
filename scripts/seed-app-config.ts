import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const initialConfigs = [
  { key: 'maintenance_mode', value: 'false', description: 'Whether maintenance mode is active' },
  { key: 'maintenance_message', value: 'The app is currently under maintenance. Please try again later.', description: 'Message shown to users' },
  { key: 'min_android_build', value: '1', description: 'Minimum Android build number required' },
  { key: 'min_ios_build', value: '1', description: 'Minimum iOS build number required' },
  { key: 'android_store_url', value: 'https://play.google.com/store', description: 'Android Play Store deep link URL' },
  { key: 'ios_store_url', value: 'https://apps.apple.com/store', description: 'iOS App Store deep link URL' },
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
