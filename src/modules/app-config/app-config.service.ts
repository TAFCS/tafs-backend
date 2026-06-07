import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AppPlatform } from './dto/app-config.dto';

@Injectable()
export class AppConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getAppStatus(platform: AppPlatform, build: number) {
    const configs = await this.prisma.app_config.findMany({
      where: {
        key: {
          in: [
            'maintenance_mode',
            'maintenance_message',
            'min_android_build',
            'min_ios_build',
            'android_store_url',
            'ios_store_url',
          ],
        },
      },
    });

    const configsMap = new Map<string, string>();
    for (const config of configs) {
      configsMap.set(config.key, config.value);
    }

    const maintenanceMode = configsMap.get('maintenance_mode')?.toLowerCase() === 'true';
    const maintenanceMessage = configsMap.get('maintenance_message') || 'The app is currently under maintenance. Please try again later.';

    let minBuildNumber = 0;
    let storeUrl = '';

    if (platform === AppPlatform.ANDROID) {
      minBuildNumber = parseInt(configsMap.get('min_android_build') || '0', 10);
      storeUrl = configsMap.get('android_store_url') || 'https://play.google.com/store';
    } else if (platform === AppPlatform.IOS) {
      minBuildNumber = parseInt(configsMap.get('min_ios_build') || '0', 10);
      storeUrl = configsMap.get('ios_store_url') || 'https://apps.apple.com/store';
    }

    const forceUpdate = build < minBuildNumber;

    return {
      maintenanceMode,
      maintenanceMessage,
      forceUpdate,
      minBuildNumber,
      storeUrl,
    };
  }

  async getAllConfigs() {
    return this.prisma.app_config.findMany({
      orderBy: { key: 'asc' },
    });
  }

  async setConfig(key: string, value: string, userId: string) {
    return this.prisma.app_config.upsert({
      where: { key },
      update: {
        value,
        updated_by: userId,
      },
      create: {
        key,
        value,
        updated_by: userId,
      },
    });
  }
}
