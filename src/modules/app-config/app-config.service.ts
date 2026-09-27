import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AppPlatform } from './dto/app-config.dto';

/**
 * Time of day (PKT, "HH:MM") from which HR may override TODAY's staff attendance
 * even if the day isn't complete (e.g. a missing clock-out). Before it, today
 * stays locked unless both punches exist. Read by the webapp only — the backend
 * override routes have no same-day block of their own (Staff Register marks
 * today in the morning).
 */
export const ATTENDANCE_OVERRIDE_CUTOFF_KEY = 'attendance_same_day_override_cutoff';
export const DEFAULT_ATTENDANCE_OVERRIDE_CUTOFF = '15:00';
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

@Injectable()
export class AppConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

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

  async getAttendanceOverrideCutoff(): Promise<string> {
    const row = await this.prisma.app_config.findUnique({ where: { key: ATTENDANCE_OVERRIDE_CUTOFF_KEY } });
    return row && HH_MM.test(row.value) ? row.value : DEFAULT_ATTENDANCE_OVERRIDE_CUTOFF;
  }

  async setConfig(key: string, value: string, userId: string) {
    if (key === ATTENDANCE_OVERRIDE_CUTOFF_KEY && !HH_MM.test(value)) {
      throw new BadRequestException('Cut-off time must be HH:MM (24-hour), e.g. 15:00.');
    }
    const existing = await this.prisma.app_config.findUnique({ where: { key } });

    const record = await this.prisma.app_config.upsert({
      where: { key },
      update: {
        value,
        updated_by: userId,
      },
      create: {
        key,
        value,
        updated_by: userId,
        updated_at: new Date(),
      },
    });

    await this.auditLogs.log({
      entity_type: 'APP_CONFIG',
      entity_id: key,
      action: existing ? 'UPDATED' : 'CREATED',
      field: 'value',
      old_value: existing?.value ?? null,
      new_value: value,
      changed_by: userId,
      note: existing
        ? `App config "${key}" changed from "${existing.value}" to "${value}".`
        : `App config "${key}" created with value "${value}".`,
    });

    return record;
  }
}
