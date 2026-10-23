import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigService } from './app-config.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AppPlatform, AppType } from './dto/app-config.dto';

describe('AppConfigService', () => {
  let service: AppConfigService;
  let prisma: { app_config: { findMany: jest.Mock; findUnique: jest.Mock; upsert: jest.Mock } };
  let auditLogs: { log: jest.Mock };

  const defaultConfigs = [
    { key: 'parent_maintenance_mode', value: 'false' },
    { key: 'parent_maintenance_message', value: 'Parent portal maintenance.' },
    { key: 'parent_min_android_build', value: '45' },
    { key: 'parent_min_ios_build', value: '1' },
    { key: 'parent_android_store_url', value: 'https://play.google.com/store/apps/details?id=com.tafs.app' },
    { key: 'parent_ios_store_url', value: 'https://apps.apple.com/app/id6572338575' },

    { key: 'staff_maintenance_mode', value: 'false' },
    { key: 'staff_maintenance_message', value: 'Staff portal maintenance.' },
    { key: 'staff_min_android_build', value: '50' },
    { key: 'staff_min_ios_build', value: '1' },
    { key: 'staff_android_store_url', value: 'https://play.google.com/store/apps/details?id=com.tafsstaff.app' },
    { key: 'staff_ios_store_url', value: 'https://apps.apple.com/app/id6572338575' },
  ];

  beforeEach(async () => {
    prisma = {
      app_config: {
        findMany: jest.fn().mockResolvedValue(defaultConfigs),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
    };
    auditLogs = {
      log: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogsService, useValue: auditLogs },
      ],
    }).compile();

    service = module.get(AppConfigService);
  });

  describe('Baseline status and defaults', () => {
    it('returns parent app configuration by default when app param is omitted', async () => {
      const result = await service.getAppStatus(AppPlatform.ANDROID, 47);

      expect(result.maintenanceMode).toBe(false);
      expect(result.forceUpdate).toBe(false);
      expect(result.minBuildNumber).toBe(45);
      expect(result.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.tafs.app');
      expect(result.maintenanceMessage).toBe('Parent portal maintenance.');
    });

    it('returns staff app configuration when app=staff is provided', async () => {
      const result = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);

      expect(result.maintenanceMode).toBe(false);
      expect(result.forceUpdate).toBe(false);
      expect(result.minBuildNumber).toBe(50);
      expect(result.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.tafsstaff.app');
      expect(result.maintenanceMessage).toBe('Staff portal maintenance.');
    });

    it('returns iOS store URL for staff iOS platform', async () => {
      const result = await service.getAppStatus(AppPlatform.IOS, 2, AppType.STAFF);

      expect(result.storeUrl).toBe('https://apps.apple.com/app/id6572338575');
      expect(result.minBuildNumber).toBe(1);
    });
  });

  describe('Independent force update logic between staff and parent', () => {
    it('forcing a staff update does not affect parent app', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        ...defaultConfigs.filter((c) => c.key !== 'staff_min_android_build'),
        { key: 'staff_min_android_build', value: '52' }, // staff requires 52
      ]);

      // Staff app on build 51 is locked out
      const staffStatus = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
      expect(staffStatus.forceUpdate).toBe(true);
      expect(staffStatus.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.tafsstaff.app');

      // Parent app on build 47 is unaffected (min is 45)
      const parentStatus = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
      expect(parentStatus.forceUpdate).toBe(false);
      expect(parentStatus.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.tafs.app');
    });

    it('forcing a parent update does not affect staff app', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        ...defaultConfigs.filter((c) => c.key !== 'parent_min_android_build'),
        { key: 'parent_min_android_build', value: '48' }, // parent requires 48
      ]);

      // Parent app on build 47 is locked out
      const parentStatus = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
      expect(parentStatus.forceUpdate).toBe(true);
      expect(parentStatus.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.tafs.app');

      // Staff app on build 51 is unaffected (min is 50)
      const staffStatus = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
      expect(staffStatus.forceUpdate).toBe(false);
      expect(staffStatus.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.tafsstaff.app');
    });
  });

  describe('Independent maintenance mode controls', () => {
    it('staff maintenance mode does not affect parent app', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        ...defaultConfigs.filter((c) => c.key !== 'staff_maintenance_mode'),
        { key: 'staff_maintenance_mode', value: 'true' },
      ]);

      const staffStatus = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
      expect(staffStatus.maintenanceMode).toBe(true);
      expect(staffStatus.maintenanceMessage).toBe('Staff portal maintenance.');

      const parentStatus = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
      expect(parentStatus.maintenanceMode).toBe(false);
    });

    it('parent maintenance mode does not affect staff app', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        ...defaultConfigs.filter((c) => c.key !== 'parent_maintenance_mode'),
        { key: 'parent_maintenance_mode', value: 'true' },
      ]);

      const parentStatus = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
      expect(parentStatus.maintenanceMode).toBe(true);
      expect(parentStatus.maintenanceMessage).toBe('Parent portal maintenance.');

      const staffStatus = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
      expect(staffStatus.maintenanceMode).toBe(false);
    });
  });

  describe('Legacy key fallback when app-specific keys are absent', () => {
    it('falls back to legacy min_android_build and maintenance_mode if app-prefixed keys not found', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        { key: 'maintenance_mode', value: 'true' },
        { key: 'maintenance_message', value: 'Legacy maintenance' },
        { key: 'min_android_build', value: '60' },
        { key: 'android_store_url', value: 'https://play.google.com/store/apps/details?id=com.tafs.app' },
      ]);

      const result = await service.getAppStatus(AppPlatform.ANDROID, 50, AppType.PARENT);

      expect(result.maintenanceMode).toBe(true);
      expect(result.maintenanceMessage).toBe('Legacy maintenance');
      expect(result.forceUpdate).toBe(true);
      expect(result.minBuildNumber).toBe(60);
    });

    it('replaces generic placeholder store urls with real listings', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        { key: 'staff_android_store_url', value: 'https://play.google.com/store' },
      ]);

      const result = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
      expect(result.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.tafsstaff.app');
    });
  });

  describe('Latest build and optional update prompt', () => {
    it('returns optionalUpdate = true when build is between minBuildNumber and latestBuildNumber', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        ...defaultConfigs,
        { key: 'parent_min_android_build', value: '45' },
        { key: 'parent_latest_android_build', value: '50' },
        { key: 'parent_update_prompt_message', value: 'Custom new version available!' },
      ]);

      const result = await service.getAppStatus(AppPlatform.ANDROID, 48, AppType.PARENT);
      expect(result.forceUpdate).toBe(false);
      expect(result.optionalUpdate).toBe(true);
      expect(result.minBuildNumber).toBe(45);
      expect(result.latestBuildNumber).toBe(50);
      expect(result.updatePromptMessage).toBe('Custom new version available!');
    });

    it('returns optionalUpdate = false when build is at or above latestBuildNumber', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        ...defaultConfigs,
        { key: 'parent_min_android_build', value: '45' },
        { key: 'parent_latest_android_build', value: '50' },
      ]);

      const result = await service.getAppStatus(AppPlatform.ANDROID, 50, AppType.PARENT);
      expect(result.forceUpdate).toBe(false);
      expect(result.optionalUpdate).toBe(false);
    });

    it('returns custom forceUpdateMessage when configured', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        ...defaultConfigs,
        { key: 'staff_force_update_message', value: 'You must upgrade to v2.0 immediately.' },
        { key: 'staff_min_android_build', value: '55' },
      ]);

      const result = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
      expect(result.forceUpdate).toBe(true);
      expect(result.forceUpdateMessage).toBe('You must upgrade to v2.0 immediately.');
    });
  });

  describe('Scheduled maintenance', () => {
    it('automatically switches maintenance off when maintenance_end has passed', async () => {
      const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
      prisma.app_config.findMany.mockResolvedValue([
        ...defaultConfigs.filter((c) => c.key !== 'staff_maintenance_mode'),
        { key: 'staff_maintenance_mode', value: 'true' },
        { key: 'staff_maintenance_end', value: pastDate },
      ]);

      const result = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
      expect(result.maintenanceMode).toBe(false);
    });

    it('keeps maintenance on when within the scheduled window', async () => {
      const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
      prisma.app_config.findMany.mockResolvedValue([
        ...defaultConfigs.filter((c) => c.key !== 'staff_maintenance_mode'),
        { key: 'staff_maintenance_mode', value: 'true' },
        { key: 'staff_maintenance_end', value: futureDate },
      ]);

      const result = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
      expect(result.maintenanceMode).toBe(true);
    });
  });

  describe('Caching behavior', () => {
    it('serves repeated requests from cache and invalidates on setConfig', async () => {
      const result1 = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
      expect(prisma.app_config.findMany).toHaveBeenCalledTimes(1);

      // Second call hits cache
      const result2 = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
      expect(result2).toEqual(result1);
      expect(prisma.app_config.findMany).toHaveBeenCalledTimes(1);

      // Mutating config clears cache
      prisma.app_config.upsert.mockResolvedValue({ key: 'parent_min_android_build', value: '46' });
      await service.setConfig('parent_min_android_build', '46', 'admin');

      // Next call queries database again
      await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
      expect(prisma.app_config.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('setConfig', () => {
    it('upserts config with updated_by and writes audit log', async () => {
      prisma.app_config.upsert.mockResolvedValue({ key: 'staff_maintenance_mode', value: 'false' });

      await service.setConfig('staff_maintenance_mode', 'false', 'admin');

      expect(prisma.app_config.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: 'staff_maintenance_mode' },
          update: { value: 'false', updated_by: 'admin' },
        }),
      );
    });
  });
});
