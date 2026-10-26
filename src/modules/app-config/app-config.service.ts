import { BadRequestException, ForbiddenException, Injectable, HttpStatus } from '@nestjs/common';
import { StaffRole, type app_config } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService, type AuditLogParams } from '../audit-logs/audit-logs.service';
import { actionsCover } from '../access/tiles.manifest';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
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

export const DEVELOPER_SETTINGS_KEYS = new Set([
  // Staff App Versions & Store
  'staff_min_android_build',
  'staff_latest_android_build',
  'staff_min_ios_build',
  'staff_latest_ios_build',
  'staff_android_store_url',
  'staff_ios_store_url',
  'staff_force_update_message',
  'staff_update_prompt_message',

  // Staff Maintenance
  'staff_maintenance_mode',
  'staff_maintenance_message',
  'staff_maintenance_start',
  'staff_maintenance_end',

  // Parent App Versions & Store
  'parent_min_android_build',
  'parent_latest_android_build',
  'parent_min_ios_build',
  'parent_latest_ios_build',
  'parent_android_store_url',
  'parent_ios_store_url',
  'parent_force_update_message',
  'parent_update_prompt_message',

  // Parent Maintenance
  'parent_maintenance_mode',
  'parent_maintenance_message',
  'parent_maintenance_start',
  'parent_maintenance_end',

  // Legacy fallback keys
  'min_android_build',
  'min_ios_build',
  'android_store_url',
  'ios_store_url',
  'maintenance_mode',
  'maintenance_message',

  // System & Developer Feature Flags
  'pay_immediately_enabled',
  'attendance_same_day_override_cutoff',
  'slc_last_number',
]);

export function isNotificationTemplateKey(key: string): boolean {
  return /^notif_[a-zA-Z0-9_]+$/.test(key);
}

@Injectable()
export class AppConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private statusCache = new Map<string, { data: any; expiresAt: number }>();
  private accessRulesCache = new Map<string, { data: any; expiresAt: number }>();

  /**
   * Fast, short-cached check used by AppMaintenanceGuard on incoming mobile requests.
   * Cached for 5 seconds to avoid DB load on every request while reacting promptly
   * to changes and scheduled maintenance windows.
   */
  async checkAppAccess(
    app: AppType,
    platform: AppPlatform = AppPlatform.ANDROID,
    build?: number,
  ): Promise<{
    allowed: boolean;
    status?: HttpStatus | number;
    code?: 'MAINTENANCE' | 'UPGRADE_REQUIRED';
    message?: string;
    minBuildNumber?: number;
    storeUrl?: string;
  }> {
    const appPrefix = app === AppType.STAFF ? 'staff' : 'parent';
    const nowMs = Date.now();
    const cacheKey = `${appPrefix}:${platform}`;
    const cached = this.accessRulesCache.get(cacheKey);

    let rules: {
      maintenanceMode: boolean;
      maintenanceMessage: string;
      forceUpdateMessage: string;
      minBuildNumber: number;
      storeUrl: string;
    };

    if (cached && cached.expiresAt > nowMs) {
      rules = cached.data;
    } else {
      const keysToQuery = [
        `${appPrefix}_maintenance_mode`,
        `${appPrefix}_maintenance_message`,
        `${appPrefix}_maintenance_start`,
        `${appPrefix}_maintenance_end`,
        `${appPrefix}_min_${platform}_build`,
        `${appPrefix}_force_update_message`,
        `${appPrefix}_${platform}_store_url`,
        'maintenance_mode',
        'maintenance_message',
        `min_${platform}_build`,
        `${platform}_store_url`,
      ];

      const configs = await this.prisma.app_config.findMany({
        where: { key: { in: keysToQuery } },
      });

      const configsMap = new Map<string, string>();
      for (const config of configs) {
        configsMap.set(config.key, config.value);
      }

      const rawMaintenanceMode =
        configsMap.get(`${appPrefix}_maintenance_mode`) ??
        configsMap.get('maintenance_mode');
      let maintenanceMode = rawMaintenanceMode?.toLowerCase() === 'true';

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

      const rawMinBuild =
        configsMap.get(`${appPrefix}_min_${platform}_build`) ??
        configsMap.get(`min_${platform}_build`);
      const minBuildNumber = parseInt(rawMinBuild || '0', 10);

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

      rules = {
        maintenanceMode,
        maintenanceMessage,
        forceUpdateMessage,
        minBuildNumber,
        storeUrl,
      };

      if (this.accessRulesCache.size > 200) {
        this.accessRulesCache.clear();
      }
      this.accessRulesCache.set(cacheKey, {
        data: rules,
        expiresAt: nowMs + 5 * 1000,
      });
    }

    if (rules.maintenanceMode) {
      return {
        allowed: false,
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'MAINTENANCE',
        message: rules.maintenanceMessage,
      };
    }

    if (build !== undefined && !isNaN(build) && build < rules.minBuildNumber) {
      return {
        allowed: false,
        status: 426,
        code: 'UPGRADE_REQUIRED',
        message: rules.forceUpdateMessage,
        minBuildNumber: rules.minBuildNumber,
        storeUrl: rules.storeUrl,
      };
    }

    return { allowed: true };
  }

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

  assertPermissionForKey(key: string, user: IJwtStaffPayload) {
    if (!user) {
      throw new ForbiddenException('Staff authentication required.');
    }

    if (isNotificationTemplateKey(key)) {
      const isSuperAdmin = user.role === StaffRole.SUPER_ADMIN;
      const holdsAction = actionsCover(new Set(user.actions ?? []), 'communication.notification_templates#edit');
      if (!isSuperAdmin && !holdsAction) {
        throw new ForbiddenException(
          'Missing permission: communication.notification_templates#edit is required to modify notification templates.',
        );
      }
      return;
    }

    if (DEVELOPER_SETTINGS_KEYS.has(key)) {
      if (user.role !== StaffRole.SUPER_ADMIN) {
        throw new ForbiddenException(
          'Developer settings keys (app version, store, maintenance, and system switches) are restricted to SUPER_ADMIN only.',
        );
      }
      return;
    }

    throw new BadRequestException(`Configuration key "${key}" is not recognized or not allowlisted.`);
  }

  validateKeyValue(key: string, value: string) {
    if (typeof value !== 'string') {
      throw new BadRequestException(`Value for "${key}" must be a string.`);
    }

    // 1. Build numbers
    if (key.endsWith('_build') || key === 'slc_last_number') {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) {
        throw new BadRequestException(`Build number for "${key}" must be a non-negative integer.`);
      }
      return;
    }

    // 2. URLs
    if (key.endsWith('_url')) {
      const trimmed = value.trim();
      try {
        const parsed = new URL(trimmed);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error();
        }
      } catch {
        throw new BadRequestException(`URL for "${key}" must be a valid http or https URL.`);
      }
      return;
    }

    // 3. Boolean flags
    if (key.endsWith('_mode') || key.endsWith('_disabled') || key === 'pay_immediately_enabled') {
      const trimmed = value.trim().toLowerCase();
      if (trimmed !== 'true' && trimmed !== 'false') {
        throw new BadRequestException(`Value for "${key}" must be "true" or "false".`);
      }
      return;
    }

    // 4. Maintenance start & end timestamps
    if (key.endsWith('_maintenance_start') || key.endsWith('_maintenance_end')) {
      const trimmed = value.trim();
      if (trimmed !== '') {
        const d = new Date(trimmed);
        if (isNaN(d.getTime())) {
          throw new BadRequestException(`Timestamp for "${key}" must be a valid ISO date/time string or empty.`);
        }
      }
      return;
    }

    // 5. Attendance override cut-off
    if (key === ATTENDANCE_OVERRIDE_CUTOFF_KEY) {
      if (!HH_MM.test(value.trim())) {
        throw new BadRequestException('Cut-off time must be HH:MM (24-hour), e.g. 15:00.');
      }
      return;
    }

    // 6. Text messages & templates
    if (value.length > 5000) {
      throw new BadRequestException(`Value for "${key}" exceeds maximum allowed length of 5000 characters.`);
    }
  }

  async batchSetConfigs(
    updates: { key: string; value: string }[],
    userOrUsername: IJwtStaffPayload | string,
  ) {
    if (!updates || updates.length === 0) {
      throw new BadRequestException('No configuration updates provided.');
    }

    const user: IJwtStaffPayload = typeof userOrUsername === 'string'
      ? ({
          username: userOrUsername,
          role: StaffRole.SUPER_ADMIN,
          actions: ['system.developer_settings#edit', 'communication.notification_templates#edit'],
        } as any)
      : userOrUsername;

    // 1. Validate permissions and key formats for ALL updates before database access
    for (const update of updates) {
      this.assertPermissionForKey(update.key, user);
      this.validateKeyValue(update.key, update.value);
    }

    // 2. Perform updates in a single database transaction
    const { records, auditEntries } = await this.prisma.$transaction(async (tx) => {
      const records: app_config[] = [];
      const auditEntries: AuditLogParams[] = [];

      for (const update of updates) {
        const trimmedKey = update.key.trim();
        const trimmedValue = update.value.trim();

        const existing = await tx.app_config.findUnique({ where: { key: trimmedKey } });

        const record = await tx.app_config.upsert({
          where: { key: trimmedKey },
          update: {
            value: trimmedValue,
            updated_by: user.username,
            updated_at: new Date(),
          },
          create: {
            key: trimmedKey,
            value: trimmedValue,
            updated_by: user.username,
            updated_at: new Date(),
          },
        });
        records.push(record);

        auditEntries.push({
          entity_type: 'APP_CONFIG',
          entity_id: trimmedKey,
          action: existing ? 'UPDATED' : 'CREATED',
          field: 'value',
          old_value: existing?.value ?? null,
          new_value: trimmedValue,
          changed_by: user.username,
          note: existing
            ? `App config "${trimmedKey}" changed from "${existing.value}" to "${trimmedValue}".`
            : `App config "${trimmedKey}" created with value "${trimmedValue}".`,
        });
      }

      return { records, auditEntries };
    });

    // 3. Invalidate status and access rules caches on mutation
    this.statusCache.clear();
    this.accessRulesCache.clear();

    // 4. Log audit entries
    if (auditEntries.length > 0) {
      await this.auditLogs.logMany(auditEntries);
    }

    return records;
  }

  async setConfig(key: string, value: string, userOrUsername: IJwtStaffPayload | string) {
    const records = await this.batchSetConfigs([{ key, value }], userOrUsername);
    return records[0];
  }
}
