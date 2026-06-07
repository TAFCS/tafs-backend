/**
 * Phase 2 — Admin flow tests (config mutations + verification via AppConfigService).
 * Simulates what /admin/developer saves without requiring a running HTTP server.
 *
 * Usage: npx ts-node scripts/test-app-config-admin-flow.ts
 */
import { PrismaClient } from '@prisma/client';
import { AppConfigService } from '../src/modules/app-config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppPlatform } from '../src/modules/app-config/dto/app-config.dto';

const prisma = new PrismaClient();
const service = new AppConfigService(prisma as unknown as PrismaService);

const results: { name: string; pass: boolean; detail?: string }[] = [];

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function setKey(key: string, value: string) {
  await prisma.app_config.upsert({
    where: { key },
    update: { value, updated_by: 'TEST_ADMIN_FLOW' },
    create: { key, value, updated_by: 'TEST_ADMIN_FLOW' },
  });
}

async function main() {
  console.log('\nApp Config Test Plan — Phase 2 Admin Flow\n');

  await setKey('maintenance_mode', 'true');
  let status = await service.getAppStatus(AppPlatform.ANDROID, 9);
  record('2.3 maintenance ON', status.maintenanceMode === true);

  await setKey('maintenance_message', 'Scheduled maintenance until 10 PM.');
  status = await service.getAppStatus(AppPlatform.ANDROID, 9);
  record(
    '2.4 custom maintenance message',
    status.maintenanceMessage === 'Scheduled maintenance until 10 PM.',
  );

  await setKey('maintenance_mode', 'false');
  status = await service.getAppStatus(AppPlatform.ANDROID, 9);
  record('2.3 maintenance OFF', status.maintenanceMode === false);

  await setKey('min_android_build', '10');
  status = await service.getAppStatus(AppPlatform.ANDROID, 9);
  record('2.5 min build 10 → forceUpdate', status.forceUpdate === true);

  await setKey('min_android_build', '9');
  status = await service.getAppStatus(AppPlatform.ANDROID, 9);
  record('2.5 min build 9 → no forceUpdate', status.forceUpdate === false);

  await setKey('android_store_url', 'https://play.google.com/store/apps/details?id=com.tafs.parent');
  status = await service.getAppStatus(AppPlatform.ANDROID, 9);
  record('2.5 store URL', status.storeUrl.includes('com.tafs.parent'));

  // 2.1 SUPER_ADMIN access covered by Jest controller spec (see npm test app-config)

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nSummary: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
