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

  private statusCache = new Map<string, { data: any; expiresAt: number }>();

  /**
   * Retrieves the current app status (maintenance mode, force-update requirement,
   * optional update availability, build numbers, and platform store URL) for a
   * specific app (staff or parent) and target platform (Android or iOS).
   *
   * Features:
   * - 30-second in-memory cache to handle high-frequency app launch requests.
   * - Scheduled maintenance windows (start/end) so maintenance switches off automatically.
   * - Optional update prompt when build is between min_build and latest_build.
   * - Customizable force-update and update-prompt messages with sensible defaults.
   *
   * Backwards Compatibility:
   * If the `app` parameter is omitted, it safely defaults to `AppType.PARENT`.
   */
  async getAppStatus(
    platform: AppPlatform,
    build: number,
    app: AppType = AppType.PARENT,
  ) {
    const cacheKey = `${app}:${platform}:${build}`;
    const nowMs = Date.now();
    const cached = this.statusCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) {
      return cached.data;
    }

    const appPrefix = app === AppType.STAFF ? 'staff' : 'parent';

    // Query both app-specific keys and fallback to legacy keys if ever needed
    const keysToQuery = [
      `${appPrefix}_maintenance_mode`,
      `${appPrefix}_maintenance_message`,
      `${appPrefix}_maintenance_start`,
      `${appPrefix}_maintenance_end`,
      `${appPrefix}_min_${platform}_build`,
      `${appPrefix}_latest_${platform}_build`,
      `${appPrefix}_force_update_message`,
      `${appPrefix}_update_prompt_message`,
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
    let maintenanceMode = rawMaintenanceMode?.toLowerCase() === 'true';

    // Scheduled maintenance: check start and end timestamps/ISO strings
    const maintenanceStartStr = configsMap.get(`${appPrefix}_maintenance_start`);
    const maintenanceEndStr = configsMap.get(`${appPrefix}_maintenance_end`);

    if (maintenanceMode) {
      const nowDate = new Date();
      if (maintenanceStartStr && maintenanceStartStr.trim()) {
        const startDate = new Date(maintenanceStartStr.trim());
        if (!isNaN(startDate.getTime()) && nowDate < startDate) {
          maintenanceMode = false;
        }
      }
      if (maintenanceEndStr && maintenanceEndStr.trim()) {
        const endDate = new Date(maintenanceEndStr.trim());
        if (!isNaN(endDate.getTime()) && nowDate > endDate) {
          // Maintenance scheduled window has ended; automatically switches off
          maintenanceMode = false;
        }
      }
    }

    const maintenanceMessage =
      configsMap.get(`${appPrefix}_maintenance_message`) ??
      configsMap.get('maintenance_message') ??
      'The app is currently under maintenance. Please try again later.';

    const forceUpdateMessage =
      configsMap.get(`${appPrefix}_force_update_message`) ??
      'A new version of the app is available with critical improvements and new features. Please update to continue.';

    const updatePromptMessage =
      configsMap.get(`${appPrefix}_update_prompt_message`) ??
      'A new version of the app is available with improvements and bug fixes. Would you like to update now?';

    const rawMinBuild =
      configsMap.get(`${appPrefix}_min_${platform}_build`) ??
      configsMap.get(`min_${platform}_build`);
    const minBuildNumber = parseInt(rawMinBuild || '0', 10);

    const rawLatestBuild =
      configsMap.get(`${appPrefix}_latest_${platform}_build`);
    const latestBuildNumber = parseInt(rawLatestBuild || `${minBuildNumber}`, 10);

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
    const optionalUpdate = !forceUpdate && !maintenanceMode && build < latestBuildNumber;

    const result = {
      maintenanceMode,
      maintenanceMessage,
      forceUpdate,
      minBuildNumber,
      latestBuildNumber,
      optionalUpdate,
      forceUpdateMessage,
      updatePromptMessage,
      storeUrl,
    };

    // Cache status response for 30 seconds
    if (this.statusCache.size > 2000) {
      this.statusCache.clear();
    }
    this.statusCache.set(cacheKey, {
      data: result,
      expiresAt: nowMs + 30 * 1000,
    });

    return result;
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

    // Invalidate status cache on any configuration mutation
    this.statusCache.clear();

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
