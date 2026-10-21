import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AppPlatform, AppType } from './dto/app-config.dto';

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

  /**
   * Retrieves the current app status (maintenance mode, force-update requirement,
   * minimum build number, and platform store URL) for a specific app (staff or parent)
   * and target platform (Android or iOS).
   *
   * Backwards Compatibility:
   * If the `app` parameter is omitted, it safely defaults to `AppType.PARENT`.
   * This preserves seamless behavior for legacy parent mobile app builds that omit
   * the `app` query parameter.
   */
  async getAppStatus(
    platform: AppPlatform,
    build: number,
    app: AppType = AppType.PARENT,
  ) {
    const appPrefix = app === AppType.STAFF ? 'staff' : 'parent';

    // Query both app-specific keys and fallback to legacy keys if ever needed
    const keysToQuery = [
      `${appPrefix}_maintenance_mode`,
      `${appPrefix}_maintenance_message`,
      `${appPrefix}_min_${platform}_build`,
      `${appPrefix}_${platform}_store_url`,
      'maintenance_mode',
      'maintenance_message',
      `min_${platform}_build`,
      `${platform}_store_url`,
    ];

    const configs = await this.prisma.app_config.findMany({
      where: {
        key: {
          in: keysToQuery,
        },
      },
    });

    const configsMap = new Map<string, string>();
    for (const config of configs) {
      configsMap.set(config.key, config.value);
    }

    const rawMaintenanceMode =
      configsMap.get(`${appPrefix}_maintenance_mode`) ??
      configsMap.get('maintenance_mode');
    const maintenanceMode = rawMaintenanceMode?.toLowerCase() === 'true';

    const maintenanceMessage =
      configsMap.get(`${appPrefix}_maintenance_message`) ??
      configsMap.get('maintenance_message') ??
      'The app is currently under maintenance. Please try again later.';

    const rawMinBuild =
      configsMap.get(`${appPrefix}_min_${platform}_build`) ??
      configsMap.get(`min_${platform}_build`);
    const minBuildNumber = parseInt(rawMinBuild || '0', 10);

    // Canonical store listings per app & platform (avoiding generic homepage placeholders)
    const fallbackStoreUrl =
      platform === AppPlatform.ANDROID
        ? (app === AppType.STAFF
            ? 'https://play.google.com/store/apps/details?id=com.tafsstaff.app'
            : 'https://play.google.com/store/apps/details?id=com.tafs.app')
        : 'https://apps.apple.com/app/id6572338575';

    const configuredStoreUrl =
      configsMap.get(`${appPrefix}_${platform}_store_url`) ??
      configsMap.get(`${platform}_store_url`);

    const storeUrl =
      configuredStoreUrl &&
      !['https://play.google.com/store', 'https://apps.apple.com/store'].includes(configuredStoreUrl)
        ? configuredStoreUrl
        : fallbackStoreUrl;

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
