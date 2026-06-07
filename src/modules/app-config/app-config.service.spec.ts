import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigService } from './app-config.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AppPlatform } from './dto/app-config.dto';

describe('AppConfigService (Test Plan Phase 1)', () => {
  let service: AppConfigService;
  let prisma: { app_config: { findMany: jest.Mock; upsert: jest.Mock } };

  const defaultConfigs = [
    { key: 'maintenance_mode', value: 'false' },
    { key: 'maintenance_message', value: 'The app is currently under maintenance. Please try again later.' },
    { key: 'min_android_build', value: '1' },
    { key: 'min_ios_build', value: '1' },
    { key: 'android_store_url', value: 'https://play.google.com/store' },
    { key: 'ios_store_url', value: 'https://apps.apple.com/store' },
  ];

  beforeEach(async () => {
    prisma = {
      app_config: {
        findMany: jest.fn().mockResolvedValue(defaultConfigs),
        upsert: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppConfigService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(AppConfigService);
  });

  describe('1.1 baseline status', () => {
    it('returns maintenance off and forceUpdate false for build 9 on android', async () => {
      const result = await service.getAppStatus(AppPlatform.ANDROID, 9);

      expect(result.maintenanceMode).toBe(false);
      expect(result.forceUpdate).toBe(false);
      expect(result.minBuildNumber).toBe(1);
      expect(result.storeUrl).toBe('https://play.google.com/store');
      expect(result.maintenanceMessage).toContain('maintenance');
    });

    it('returns ios store URL for ios platform', async () => {
      const result = await service.getAppStatus(AppPlatform.IOS, 9);

      expect(result.storeUrl).toBe('https://apps.apple.com/store');
      expect(result.minBuildNumber).toBe(1);
    });
  });

  describe('1.2 force update logic', () => {
    beforeEach(() => {
      prisma.app_config.findMany.mockResolvedValue(
        defaultConfigs.map((c) =>
          c.key === 'min_android_build' ? { ...c, value: '10' } : c,
        ),
      );
    });

    it('forceUpdate true when build 9 < min 10', async () => {
      const result = await service.getAppStatus(AppPlatform.ANDROID, 9);
      expect(result.forceUpdate).toBe(true);
    });

    it('forceUpdate false when build 10 >= min 10', async () => {
      expect((await service.getAppStatus(AppPlatform.ANDROID, 10)).forceUpdate).toBe(false);
      expect((await service.getAppStatus(AppPlatform.ANDROID, 11)).forceUpdate).toBe(false);
    });
  });

  describe('1.3 maintenance mode', () => {
    beforeEach(() => {
      prisma.app_config.findMany.mockResolvedValue(
        defaultConfigs.map((c) =>
          c.key === 'maintenance_mode' ? { ...c, value: 'true' } : c,
        ),
      );
    });

    it('maintenanceMode true when config is true', async () => {
      const result = await service.getAppStatus(AppPlatform.ANDROID, 9);
      expect(result.maintenanceMode).toBe(true);
    });
  });

  describe('1.4 custom maintenance message', () => {
    beforeEach(() => {
      prisma.app_config.findMany.mockResolvedValue(
        defaultConfigs.map((c) =>
          c.key === 'maintenance_message'
            ? { ...c, value: 'Fee portal upgrade in progress.' }
            : c,
        ),
      );
    });

    it('returns custom maintenance message from config', async () => {
      const result = await service.getAppStatus(AppPlatform.ANDROID, 9);
      expect(result.maintenanceMessage).toBe('Fee portal upgrade in progress.');
    });
  });

  describe('3.4 maintenance priority (service returns both flags)', () => {
    beforeEach(() => {
      prisma.app_config.findMany.mockResolvedValue(
        defaultConfigs.map((c) => {
          if (c.key === 'maintenance_mode') return { ...c, value: 'true' };
          if (c.key === 'min_android_build') return { ...c, value: '10' };
          return c;
        }),
      );
    });

    it('returns both maintenanceMode and forceUpdate when both apply', async () => {
      const result = await service.getAppStatus(AppPlatform.ANDROID, 9);
      expect(result.maintenanceMode).toBe(true);
      expect(result.forceUpdate).toBe(true);
    });
  });

  describe('setConfig', () => {
    it('upserts config with updated_by', async () => {
      prisma.app_config.upsert.mockResolvedValue({ key: 'maintenance_mode', value: 'false' });

      await service.setConfig('maintenance_mode', 'false', 'admin');

      expect(prisma.app_config.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: 'maintenance_mode' },
          update: { value: 'false', updated_by: 'admin' },
        }),
      );
    });
  });
});
