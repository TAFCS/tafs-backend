import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { AppConfigController } from './app-config.controller';
import { AppConfigService } from './app-config.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { StaffRole } from '@prisma/client';
import { AppPlatform } from './dto/app-config.dto';

describe('AppConfigController (Test Plan Phase 1.5 auth)', () => {
  let controller: AppConfigController;
  let service: {
    getAppStatus: jest.Mock;
    getAllConfigs: jest.Mock;
    setConfig: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      getAppStatus: jest.fn().mockResolvedValue({
        maintenanceMode: false,
        maintenanceMessage: 'ok',
        forceUpdate: false,
        minBuildNumber: 1,
        storeUrl: 'https://play.google.com/store',
      }),
      getAllConfigs: jest.fn().mockResolvedValue([]),
      setConfig: jest.fn().mockResolvedValue({ key: 'maintenance_mode', value: 'true' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppConfigController],
      providers: [{ provide: AppConfigService, useValue: service }],
    })
      .overrideGuard(JwtStaffGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AppConfigController);
  });

  it('GET status is public and returns envelope data', async () => {
    const response = await controller.getStatus({ platform: AppPlatform.ANDROID, build: 9 });

    expect(service.getAppStatus).toHaveBeenCalledWith(AppPlatform.ANDROID, 9);
    expect(response.data.forceUpdate).toBe(false);
    expect(response.status).toBe(200);
  });

  it('GET all configs allowed for SUPER_ADMIN', async () => {
    const result = await controller.getAllConfigs({
      role: StaffRole.SUPER_ADMIN,
      username: 'super',
    } as any);

    expect(service.getAllConfigs).toHaveBeenCalled();
    expect(result.status).toBe(200);
  });

  it('GET all configs forbidden for CAMPUS_ADMIN', async () => {
    await expect(
      controller.getAllConfigs({
        role: StaffRole.CAMPUS_ADMIN,
        username: 'campus',
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('PATCH config allowed for SUPER_ADMIN', async () => {
    const result = await controller.setConfig(
      'maintenance_mode',
      { value: 'true' },
      { role: StaffRole.SUPER_ADMIN, username: 'super' } as any,
    );

    expect(service.setConfig).toHaveBeenCalledWith('maintenance_mode', 'true', 'super');
    expect(result.status).toBe(200);
  });

  it('PATCH config forbidden for CAMPUS_ADMIN', async () => {
    await expect(
      controller.setConfig(
        'maintenance_mode',
        { value: 'true' },
        { role: StaffRole.CAMPUS_ADMIN, username: 'campus' } as any,
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
