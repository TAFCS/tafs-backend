/**
 * Phase 2 — Admin flow tests (config mutations + verification via AppConfigService).
 * Simulates what /admin/developer saves without requiring a running HTTP server.
 *
 * Usage: npx ts-node scripts/test-app-config-admin-flow.ts
 */
import { PrismaClient } from '@prisma/client';
import { AppConfigService } from '../src/modules/app-config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppPlatform, AppType } from '../src/modules/app-config/dto/app-config.dto';

const prisma = new PrismaClient();
const mockAuditLogs = { log: async () => {}, logMany: async () => {} } as any;
const service = new AppConfigService(prisma as unknown as PrismaService, mockAuditLogs);

const results: { name: string; pass: boolean; detail?: string }[] = [];

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function setKey(key: string, value: string) {
  await service.setConfig(key, value, 'TEST_ADMIN_FLOW');
}

async function main() {
  console.log('\nApp Config Test Plan — Multi-App Phase 2 Admin Flow\n');

  // 1. Staff maintenance ON should not affect Parent
  await setKey('staff_maintenance_mode', 'true');
  await setKey('parent_maintenance_mode', 'false');
  let staffStatus = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
  let parentStatus = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
  record('Staff maintenance ON', staffStatus.maintenanceMode === true);
  record('Parent maintenance remains OFF', parentStatus.maintenanceMode === false);

  // 2. Parent maintenance ON should not affect Staff
  await setKey('staff_maintenance_mode', 'false');
  await setKey('parent_maintenance_mode', 'true');
  staffStatus = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
  parentStatus = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
  record('Staff maintenance returns OFF', staffStatus.maintenanceMode === false);
  record('Parent maintenance ON', parentStatus.maintenanceMode === true);

  // Reset maintenance
  await setKey('parent_maintenance_mode', 'false');

  // 3. Independent build numbers and force update
  // Staff on 51, required 52 -> Staff force-update, Parent on 47 unaffected (required 45)
  await setKey('staff_min_android_build', '52');
  await setKey('parent_min_android_build', '45');
  staffStatus = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
  parentStatus = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
  record('Staff build 51 < 52 -> Staff forceUpdate = true', staffStatus.forceUpdate === true);
  record('Parent build 47 >= 45 -> Parent forceUpdate = false', parentStatus.forceUpdate === false);

  // Parent on 47, required 48 -> Parent force-update, Staff on 51 unaffected (required 50)
  await setKey('staff_min_android_build', '50');
  await setKey('parent_min_android_build', '48');
  staffStatus = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
  parentStatus = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
  record('Staff build 51 >= 50 -> Staff forceUpdate = false', staffStatus.forceUpdate === false);
  record('Parent build 47 < 48 -> Parent forceUpdate = true', parentStatus.forceUpdate === true);

  // 4. Store URLs point to the real listings
  record('Staff store URL has com.tafsstaff.app', staffStatus.storeUrl.includes('com.tafsstaff.app'));
  record('Parent store URL has com.tafs.app', parentStatus.storeUrl.includes('com.tafs.app'));

  // 5. Default omitted app param resolves to parent
  const omittedStatus = await service.getAppStatus(AppPlatform.ANDROID, 47);
  record('Omitted app param resolves to parent', omittedStatus.storeUrl.includes('com.tafs.app') && omittedStatus.forceUpdate === true);

  // 6. Latest build setting and optional update prompt
  await setKey('staff_min_android_build', '50');
  await setKey('staff_latest_android_build', '55');
  await setKey('staff_update_prompt_message', 'A new staff build is ready.');
  // Force cache clear by calling setKey
  staffStatus = await service.getAppStatus(AppPlatform.ANDROID, 52, AppType.STAFF);
  record('Staff on 52 with min 50 & latest 55 -> optionalUpdate = true', staffStatus.optionalUpdate === true);
  record('Staff on 52 -> forceUpdate = false', staffStatus.forceUpdate === false);
  record('Staff prompt message passed through', staffStatus.updatePromptMessage === 'A new staff build is ready.');

  // Staff on 55 (at latest) -> optionalUpdate = false
  const staffAtLatest = await service.getAppStatus(AppPlatform.ANDROID, 55, AppType.STAFF);
  record('Staff on 55 (at latest) -> optionalUpdate = false', staffAtLatest.optionalUpdate === false);

  // 7. Scheduled maintenance with end time in past switches off
  const pastTime = new Date(Date.now() - 3600 * 1000).toISOString();
  await setKey('staff_maintenance_mode', 'true');
  await setKey('staff_maintenance_end', pastTime);
  const scheduledStatus = await service.getAppStatus(AppPlatform.ANDROID, 55, AppType.STAFF);
  record('Scheduled maintenance with past end time automatically switches off', scheduledStatus.maintenanceMode === false);

  // Cleanup to safe defaults
  await setKey('staff_min_android_build', '9');
  await setKey('parent_min_android_build', '9');
  await setKey('staff_latest_android_build', '9');
  await setKey('parent_latest_android_build', '9');
  await setKey('staff_maintenance_mode', 'false');
  await setKey('parent_maintenance_mode', 'false');
  await setKey('staff_maintenance_end', '');

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
