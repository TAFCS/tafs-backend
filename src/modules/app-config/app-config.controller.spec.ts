import { ExecutionContext, ForbiddenException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { StaffRole } from '@prisma/client';
import { AppConfigController } from './app-config.controller';
import { AppConfigService } from './app-config.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { AppPlatform, AppType } from './dto/app-config.dto';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

describe('AppConfigController', () => {
  let controller: AppConfigController;
  let service: {
    getAppStatus: jest.Mock;
    getAllConfigs: jest.Mock;
    batchSetConfigs: jest.Mock;
  };
  let tileActionGuard: TileActionGuard;

  const mockUser: IJwtStaffPayload = {
    sub: 'user-1',
    username: 'superadmin',
    role: StaffRole.SUPER_ADMIN,
    actions: [],
    userType: 'STAFF',
  };

  function createExecutionContext(handler: (...args: any[]) => any, user?: any): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => handler,
      getClass: () => AppConfigController,
    } as unknown as ExecutionContext;
  }

  beforeEach(async () => {
    service = {
      getAppStatus: jest.fn().mockResolvedValue({
        maintenanceMode: false,
        maintenanceMessage: 'ok',
        forceUpdate: false,
        minBuildNumber: 1,
        storeUrl: 'https://play.google.com/store/apps/details?id=com.tafs.app',
      }),
      getAllConfigs: jest.fn().mockResolvedValue([]),
      batchSetConfigs: jest.fn().mockResolvedValue([{ key: 'staff_maintenance_mode', value: 'true' }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppConfigController],
      providers: [
        { provide: AppConfigService, useValue: service },
        Reflector,
      ],
    })
      .overrideGuard(JwtStaffGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TileActionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AppConfigController);
    tileActionGuard = new TileActionGuard(module.get(Reflector));
  });

  describe('Endpoint handlers', () => {
    it('GET status is public and returns envelope data with app parameter', async () => {
      const response = await controller.getStatus({
        platform: AppPlatform.ANDROID,
        build: 51,
        app: AppType.STAFF,
      });

      expect(service.getAppStatus).toHaveBeenCalledWith(AppPlatform.ANDROID, 51, AppType.STAFF);
      expect(response.data.forceUpdate).toBe(false);
      expect(response.status).toBe(HttpStatus.OK);
    });

    it('GET status works without optional app parameter', async () => {
      const response = await controller.getStatus({
        platform: AppPlatform.ANDROID,
        build: 47,
      });

      expect(service.getAppStatus).toHaveBeenCalledWith(AppPlatform.ANDROID, 47, undefined);
      expect(response.status).toBe(HttpStatus.OK);
    });

    it('GET all configs returns configs from service', async () => {
      const result = await controller.getAllConfigs();

      expect(service.getAllConfigs).toHaveBeenCalled();
      expect(result.status).toBe(HttpStatus.OK);
    });

    it('PATCH :key delegates to service.batchSetConfigs with single item array', async () => {
      const result = await controller.setConfig(
        'staff_maintenance_mode',
        { value: 'true' },
        mockUser,
      );

      expect(service.batchSetConfigs).toHaveBeenCalledWith(
        [{ key: 'staff_maintenance_mode', value: 'true' }],
        mockUser,
      );
      expect(result.status).toBe(HttpStatus.OK);
      expect(result.data).toEqual({ key: 'staff_maintenance_mode', value: 'true' });
    });

    it('PATCH / batch endpoint calls service.batchSetConfigs with updates array', async () => {
      const updates = [
        { key: 'staff_min_android_build', value: '51' },
        { key: 'staff_latest_android_build', value: '52' },
      ];
      const result = await controller.batchSetConfigs({ updates }, mockUser);

      expect(service.batchSetConfigs).toHaveBeenCalledWith(updates, mockUser);
      expect(result.status).toBe(HttpStatus.OK);
    });
  });

  describe('TileActionGuard integration', () => {
    const unprivilegedStaff: IJwtStaffPayload = {
      sub: 'user-2',
      username: 'teacher',
      role: StaffRole.TEACHER,
      actions: [],
      userType: 'STAFF',
    };

    const notifEditor: IJwtStaffPayload = {
      sub: 'user-3',
      username: 'notif_editor',
      role: StaffRole.OFFICE_STAFF,
      actions: ['communication.notification_templates#edit'],
      userType: 'STAFF',
    };

    const devEditor: IJwtStaffPayload = {
      sub: 'user-4',
      username: 'dev_editor',
      role: StaffRole.OFFICE_STAFF,
      actions: ['system.developer_settings#edit'],
      userType: 'STAFF',
    };

    it('allows public access to getStatus without staff session or actions', () => {
      const ctx = createExecutionContext(controller.getStatus);
      expect(tileActionGuard.canActivate(ctx)).toBe(true);
    });

    it('blocks unauthenticated or non-staff users from accessing batchSetConfigs', () => {
      const ctx = createExecutionContext(controller.batchSetConfigs, undefined);
      expect(() => tileActionGuard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('blocks staff without required actions from calling batchSetConfigs', () => {
      const ctx = createExecutionContext(controller.batchSetConfigs, unprivilegedStaff);
      expect(() => tileActionGuard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('allows staff with communication.notification_templates#edit to pass guard for batchSetConfigs', () => {
      const ctx = createExecutionContext(controller.batchSetConfigs, notifEditor);
      expect(tileActionGuard.canActivate(ctx)).toBe(true);
    });

    it('allows staff with system.developer_settings#edit to pass guard for batchSetConfigs', () => {
      const ctx = createExecutionContext(controller.batchSetConfigs, devEditor);
      expect(tileActionGuard.canActivate(ctx)).toBe(true);
    });

    it('allows SUPER_ADMIN to pass guard for batchSetConfigs', () => {
      const ctx = createExecutionContext(controller.batchSetConfigs, mockUser);
      expect(tileActionGuard.canActivate(ctx)).toBe(true);
    });

    it('blocks staff without required actions from calling setConfig', () => {
      const ctx = createExecutionContext(controller.setConfig, unprivilegedStaff);
      expect(() => tileActionGuard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });
});
