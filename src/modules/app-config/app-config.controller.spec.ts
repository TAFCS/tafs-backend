import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigController } from './app-config.controller';
import { AppConfigService } from './app-config.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { AppPlatform } from './dto/app-config.dto';

describe('AppConfigController', () => {
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
      .overrideGuard(TileActionGuard)
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

  it('GET all configs returns configs from service', async () => {
    const result = await controller.getAllConfigs();

    expect(service.getAllConfigs).toHaveBeenCalled();
    expect(result.status).toBe(200);
  });

  it('PATCH config calls service.setConfig', async () => {
    const result = await controller.setConfig(
      'maintenance_mode',
      { value: 'true' },
      { username: 'super' } as any,
    );

    expect(service.setConfig).toHaveBeenCalledWith('maintenance_mode', 'true', 'super');
    expect(result.status).toBe(200);
  });
});
