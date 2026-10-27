import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, HttpStatus } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { AppConfigService } from './app-config.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AppPlatform, AppType } from './dto/app-config.dto';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

describe('AppConfigService', () => {
  let service: AppConfigService;
  let prisma: {
    app_config: { findMany: jest.Mock; findUnique: jest.Mock; upsert: jest.Mock };
    $transaction: jest.Mock;
  };
  let auditLogs: { log: jest.Mock; logMany: jest.Mock };

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
        upsert: jest.fn().mockImplementation((args) =>
          Promise.resolve({ key: args.where.key, value: args.update.value }),
        ),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => {
        return cb(prisma);
      }),
    };
    auditLogs = {
      log: jest.fn(),
      logMany: jest.fn().mockResolvedValue([]),
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
        { key: 'staff_min_android_build', value: '52' },
      ]);

      const staffStatus = await service.getAppStatus(AppPlatform.ANDROID, 51, AppType.STAFF);
      expect(staffStatus.forceUpdate).toBe(true);
      expect(staffStatus.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.tafsstaff.app');

      const parentStatus = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
      expect(parentStatus.forceUpdate).toBe(false);
      expect(parentStatus.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.tafs.app');
    });

    it('forcing a parent update does not affect staff app', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        ...defaultConfigs.filter((c) => c.key !== 'parent_min_android_build'),
        { key: 'parent_min_android_build', value: '48' },
      ]);

      const parentStatus = await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
      expect(parentStatus.forceUpdate).toBe(true);
      expect(parentStatus.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.tafs.app');

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
      await service.setConfig('parent_min_android_build', '46', 'admin');

      // Next call queries database again
      await service.getAppStatus(AppPlatform.ANDROID, 47, AppType.PARENT);
      expect(prisma.app_config.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('Validation & Allowlist', () => {
    const adminUser = 'admin';

    it('rejects unrecognized keys not in developer settings or notification template allowlist', async () => {
      await expect(
        service.setConfig('malicious_key', 'evil', adminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects negative or NaN build numbers', async () => {
      await expect(
        service.setConfig('staff_min_android_build', '-1', adminUser),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.setConfig('parent_min_ios_build', 'NaN', adminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects invalid store URLs', async () => {
      await expect(
        service.setConfig('staff_android_store_url', 'not-a-url', adminUser),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.setConfig('parent_ios_store_url', 'javascript:alert(1)', adminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects invalid boolean flags', async () => {
      await expect(
        service.setConfig('staff_maintenance_mode', 'yes', adminUser),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.setConfig('pay_immediately_enabled', '1', adminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects invalid attendance override cut-off values', async () => {
      await expect(
        service.setConfig('attendance_same_day_override_cutoff', '3pm', adminUser),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.setConfig('attendance_same_day_override_cutoff', '25:00', adminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects invalid maintenance timestamps', async () => {
      await expect(
        service.setConfig('staff_maintenance_start', 'tomorrow-at-five', adminUser),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Permission gating per key group', () => {
    const regularStaffUser: IJwtStaffPayload = {
      sub: 'user-1',
      username: 'clerk',
      role: StaffRole.TEACHER,
      campusId: null,
      allowedClassIds: [],
      permissions: [],
      actions: [],
      userType: 'STAFF',
    };

    const notifManagerUser: IJwtStaffPayload = {
      sub: 'user-2',
      username: 'notif_admin',
      role: StaffRole.TEACHER,
      campusId: null,
      allowedClassIds: [],
      permissions: [],
      actions: ['communication.notification_templates#edit'],
      userType: 'STAFF',
    };

    const devAdminUser: IJwtStaffPayload = {
      sub: 'user-3',
      username: 'dev_admin',
      role: StaffRole.TEACHER,
      campusId: null,
      allowedClassIds: [],
      permissions: [],
      actions: ['system.developer_settings#edit'],
      userType: 'STAFF',
    };

    const superAdminUser: IJwtStaffPayload = {
      sub: 'user-4',
      username: 'super_admin',
      role: StaffRole.SUPER_ADMIN,
      campusId: null,
      allowedClassIds: [],
      permissions: [],
      actions: [],
      userType: 'STAFF',
    };

    it('forbids staff lacking developer_settings#edit from editing developer keys and names key in 403', async () => {
      await expect(
        service.setConfig('maintenance_mode', 'true', notifManagerUser),
      ).rejects.toThrow(new ForbiddenException('Missing permission: system.developer_settings#edit is required to modify "maintenance_mode".'));

      await expect(
        service.setConfig('pay_immediately_enabled', 'false', notifManagerUser),
      ).rejects.toThrow(new ForbiddenException('Missing permission: system.developer_settings#edit is required to modify "pay_immediately_enabled".'));

      await expect(
        service.setConfig('attendance_same_day_override_cutoff', '16:00', notifManagerUser),
      ).rejects.toThrow(new ForbiddenException('Missing permission: system.developer_settings#edit is required to modify "attendance_same_day_override_cutoff".'));

      await expect(
        service.setConfig('parent_min_android_build', '46', regularStaffUser),
      ).rejects.toThrow(new ForbiddenException('Missing permission: system.developer_settings#edit is required to modify "parent_min_android_build".'));
    });

    it('forbids staff lacking notification_templates#edit from editing template keys and names key in 403', async () => {
      await expect(
        service.setConfig('notif_fee_issued_title', 'New Fee Voucher', devAdminUser),
      ).rejects.toThrow(new ForbiddenException('Missing permission: communication.notification_templates#edit is required to modify notification template "notif_fee_issued_title".'));

      await expect(
        service.setConfig('notif_fee_issued_body', 'Pay fees', regularStaffUser),
      ).rejects.toThrow(new ForbiddenException('Missing permission: communication.notification_templates#edit is required to modify notification template "notif_fee_issued_body".'));
    });

    it('allows staff holding developer_settings#edit to update developer keys', async () => {
      const result = await service.setConfig('staff_maintenance_mode', 'true', devAdminUser);
      expect(result).toBeDefined();
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('allows staff holding notification_templates#edit to update notification templates and disabled flags', async () => {
      const resultTitle = await service.setConfig('notif_fee_issued_title', 'New Fee Voucher', notifManagerUser);
      expect(resultTitle).toBeDefined();

      const resultDisabled = await service.setConfig('notif_fee_issued_disabled', 'true', notifManagerUser);
      expect(resultDisabled).toBeDefined();
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('allows SUPER_ADMIN to update developer settings and notification templates', async () => {
      const r1 = await service.setConfig('parent_min_android_build', '46', superAdminUser);
      const r2 = await service.setConfig('notif_fee_issued_title', 'New Title', superAdminUser);
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
    });
  });

  describe('batchSetConfigs & Audit logging', () => {
    it('saves batch updates atomically and logs audit entries with auditLogs.logMany', async () => {
      prisma.app_config.findUnique
        .mockResolvedValueOnce({ key: 'staff_min_android_build', value: '50' })
        .mockResolvedValueOnce(null);

      const updates = [
        { key: 'staff_min_android_build', value: '51' },
        { key: 'staff_latest_android_build', value: '52' },
      ];

      const records = await service.batchSetConfigs(updates, 'superadmin');
      expect(records).toHaveLength(2);
      expect(prisma.$transaction).toHaveBeenCalled();

      expect(auditLogs.logMany).toHaveBeenCalledTimes(1);
      const auditEntries = auditLogs.logMany.mock.calls[0][0];
      expect(auditEntries).toHaveLength(2);

      expect(auditEntries[0]).toMatchObject({
        entity_type: 'APP_CONFIG',
        entity_id: 'staff_min_android_build',
        action: 'UPDATED',
        old_value: '50',
        new_value: '51',
        changed_by: 'superadmin',
      });

      expect(auditEntries[1]).toMatchObject({
        entity_type: 'APP_CONFIG',
        entity_id: 'staff_latest_android_build',
        action: 'CREATED',
        old_value: null,
        new_value: '52',
        changed_by: 'superadmin',
      });
    });
  });

  describe('checkAppAccess', () => {
    it('returns allowed: false with 503 MAINTENANCE when maintenance mode is active', async () => {
      prisma.app_config.findMany.mockResolvedValueOnce([
        { key: 'parent_maintenance_mode', value: 'true' },
        { key: 'parent_maintenance_message', value: 'Parent portal is down for maintenance.' },
      ]);

      const result = await service.checkAppAccess(AppType.PARENT, AppPlatform.ANDROID);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(result.code).toBe('MAINTENANCE');
      expect(result.message).toBe('Parent portal is down for maintenance.');
    });

    it('returns allowed: false with 426 UPGRADE_REQUIRED when build < minBuildNumber', async () => {
      prisma.app_config.findMany.mockResolvedValueOnce([
        { key: 'parent_maintenance_mode', value: 'false' },
        { key: 'parent_min_android_build', value: '20' },
        { key: 'parent_force_update_message', value: 'Force update required.' },
      ]);

      const result = await service.checkAppAccess(AppType.PARENT, AppPlatform.ANDROID, 15);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(426);
      expect(result.code).toBe('UPGRADE_REQUIRED');
      expect(result.minBuildNumber).toBe(20);
      expect(result.message).toBe('Force update required.');
    });

    it('caches access rules for fast evaluation and respects cache clearing', async () => {
      prisma.app_config.findMany.mockResolvedValue([
        { key: 'staff_maintenance_mode', value: 'false' },
        { key: 'staff_min_android_build', value: '10' },
      ]);

      const r1 = await service.checkAppAccess(AppType.STAFF, AppPlatform.ANDROID, 15);
      const r2 = await service.checkAppAccess(AppType.STAFF, AppPlatform.ANDROID, 15);

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      // findMany called only once due to 5-second cache
      expect(prisma.app_config.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseStoredBuildNumber (prevent silent gate disable)', () => {
    it('correctly parses clean integer strings', () => {
      expect(service.parseStoredBuildNumber('45', 'min_android_build')).toBe(45);
      expect(service.parseStoredBuildNumber('  52  ', 'min_android_build')).toBe(52);
    });

    it('returns fallback for empty or null strings without producing NaN', () => {
      expect(service.parseStoredBuildNumber(undefined, 'min_android_build', 0)).toBe(0);
      expect(service.parseStoredBuildNumber('', 'min_android_build', 0)).toBe(0);
      expect(service.parseStoredBuildNumber('   ', 'min_android_build', 10)).toBe(10);
    });

    it('extracts embedded digits when non-numeric prefix/suffix is stored', () => {
      expect(service.parseStoredBuildNumber('v45', 'min_android_build')).toBe(45);
      expect(service.parseStoredBuildNumber('build-52', 'min_android_build')).toBe(52);
      expect(service.parseStoredBuildNumber('50-beta', 'min_android_build')).toBe(50);
    });

    it('fails closed (Number.MAX_SAFE_INTEGER) on completely non-numeric strings to prevent gate bypass', () => {
      const result = service.parseStoredBuildNumber('corrupted-data', 'min_android_build');
      expect(result).toBe(Number.MAX_SAFE_INTEGER);
      expect(Number.isNaN(result)).toBe(false);

      // Verify that any build will fail the gate rather than bypassing it
      expect(100 < result).toBe(true);
    });
  });
});


