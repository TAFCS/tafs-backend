import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AppMaintenanceGuard } from './app-maintenance.guard';
import { AppConfigService } from '../../modules/app-config/app-config.service';
import { AppPlatform, AppType } from '../../modules/app-config/dto/app-config.dto';

describe('AppMaintenanceGuard', () => {
  let guard: AppMaintenanceGuard;
  let appConfigService: Partial<AppConfigService>;
  let moduleRef: Partial<ModuleRef>;

  beforeEach(() => {
    appConfigService = {
      checkAppAccess: jest.fn().mockResolvedValue({ allowed: true }),
    };

    moduleRef = {
      get: jest.fn().mockImplementation((token) => {
        if (token === AppConfigService) return appConfigService;
        return null;
      }),
    };

    guard = new AppMaintenanceGuard(moduleRef as ModuleRef, appConfigService as AppConfigService);
  });

  function createMockContext(url: string, headers: Record<string, string | string[] | undefined> = {}) {
    const req = {
      originalUrl: url,
      url,
      headers,
    };

    return {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext;
  }

  describe('Exempt Routes', () => {
    it('allows /app-config/status without checking maintenance', async () => {
      const ctx = createMockContext('/api/v1/app-config/status?platform=android&build=1', {
        'x-app': 'parent',
      });

      const allowed = await guard.canActivate(ctx);
      expect(allowed).toBe(true);
      expect(appConfigService.checkAppAccess).not.toHaveBeenCalled();
    });

    it('allows health check endpoints', async () => {
      const ctx1 = createMockContext('/api/v1/healthz', { 'x-app': 'parent' });
      const ctx2 = createMockContext('/health', { 'x-app': 'parent' });

      expect(await guard.canActivate(ctx1)).toBe(true);
      expect(await guard.canActivate(ctx2)).toBe(true);
      expect(appConfigService.checkAppAccess).not.toHaveBeenCalled();
    });

    it('allows bank and external integration endpoints', async () => {
      const ublCtx = createMockContext('/api/v1/ubl/inquiry', { 'x-app': 'parent' });
      const meezanCtx = createMockContext('/api/v1/meezan/callback', { 'x-app': 'parent' });
      const bankCtx = createMockContext('/api/v1/bank-accounts', { 'x-app': 'parent' });
      const iclockCtx = createMockContext('/api/v1/iclock/cdata', { 'x-app': 'parent' });

      expect(await guard.canActivate(ublCtx)).toBe(true);
      expect(await guard.canActivate(meezanCtx)).toBe(true);
      expect(await guard.canActivate(bankCtx)).toBe(true);
      expect(await guard.canActivate(iclockCtx)).toBe(true);
      expect(appConfigService.checkAppAccess).not.toHaveBeenCalled();
    });

    it('allows web-admin /app-config management routes', async () => {
      const ctx = createMockContext('/api/v1/app-config', { 'x-app': 'parent' });
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(appConfigService.checkAppAccess).not.toHaveBeenCalled();
    });
  });

  describe('Non-Mobile Requests Identification', () => {
    it('allows requests without X-App header (e.g. staff web admin)', async () => {
      const ctx = createMockContext('/api/v1/students');
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(appConfigService.checkAppAccess).not.toHaveBeenCalled();
    });

    it('allows requests with unknown X-App header', async () => {
      const ctx = createMockContext('/api/v1/students', { 'x-app': 'web-browser' });
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(appConfigService.checkAppAccess).not.toHaveBeenCalled();
    });
  });

  describe('Maintenance Enforcement (503)', () => {
    it('throws 503 SERVICE_UNAVAILABLE with MAINTENANCE code when parent app is in maintenance', async () => {
      (appConfigService.checkAppAccess as jest.Mock).mockResolvedValue({
        allowed: false,
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'MAINTENANCE',
        message: 'Parent portal is currently undergoing scheduled maintenance.',
      });

      const ctx = createMockContext('/api/v1/students', {
        'x-app': 'parent',
        'x-app-build': '10',
        'x-app-platform': 'android',
      });

      try {
        await guard.canActivate(ctx);
        fail('Expected 503 HttpException to be thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect(err.getResponse()).toEqual({
          code: 'MAINTENANCE',
          message: 'Parent portal is currently undergoing scheduled maintenance.',
        });
      }

      expect(appConfigService.checkAppAccess).toHaveBeenCalledWith(
        AppType.PARENT,
        AppPlatform.ANDROID,
        10,
      );
    });

    it('allows staff app when parent maintenance is active but staff maintenance is off', async () => {
      (appConfigService.checkAppAccess as jest.Mock).mockResolvedValue({
        allowed: true,
      });

      const ctx = createMockContext('/api/v1/attendance', {
        'x-app': 'staff',
        'x-app-build': '12',
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(appConfigService.checkAppAccess).toHaveBeenCalledWith(
        AppType.STAFF,
        AppPlatform.ANDROID,
        12,
      );
    });

    it('throws 503 when staff maintenance is active for staff app', async () => {
      (appConfigService.checkAppAccess as jest.Mock).mockResolvedValue({
        allowed: false,
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'MAINTENANCE',
        message: 'Staff app maintenance in progress.',
      });

      const ctx = createMockContext('/api/v1/attendance', {
        'x-app': 'staff',
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });
  });

  describe('Upgrade Required Enforcement (426)', () => {
    it('throws 426 UPGRADE_REQUIRED when build is below minimum', async () => {
      (appConfigService.checkAppAccess as jest.Mock).mockResolvedValue({
        allowed: false,
        status: 426,
        code: 'UPGRADE_REQUIRED',
        message: 'Please update your app to continue.',
        minBuildNumber: 15,
        storeUrl: 'https://play.google.com/store/apps/details?id=com.tafs.app',
      });

      const ctx = createMockContext('/api/v1/students', {
        'x-app': 'parent',
        'x-app-build': '10',
        'x-app-platform': 'android',
      });

      try {
        await guard.canActivate(ctx);
        fail('Expected 426 HttpException to be thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(426);
        expect(err.getResponse()).toEqual({
          code: 'UPGRADE_REQUIRED',
          message: 'Please update your app to continue.',
          minBuildNumber: 15,
          storeUrl: 'https://play.google.com/store/apps/details?id=com.tafs.app',
        });
      }
    });

    it('allows request when build meets minimum version', async () => {
      (appConfigService.checkAppAccess as jest.Mock).mockResolvedValue({
        allowed: true,
      });

      const ctx = createMockContext('/api/v1/students', {
        'x-app': 'parent',
        'x-app-build': '15',
        'x-app-platform': 'android',
      });

      expect(await guard.canActivate(ctx)).toBe(true);
    });
  });
});
