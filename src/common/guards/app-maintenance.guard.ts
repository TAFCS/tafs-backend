import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { AppConfigService } from '../../modules/app-config/app-config.service';
import { AppPlatform, AppType } from '../../modules/app-config/dto/app-config.dto';

@Injectable()
export class AppMaintenanceGuard implements CanActivate {
  constructor(
    private readonly moduleRef: ModuleRef,
    private appConfigService?: AppConfigService,
  ) {}

  private getAppConfigService(): AppConfigService {
    if (!this.appConfigService) {
      this.appConfigService = this.moduleRef.get(AppConfigService, { strict: false });
    }
    return this.appConfigService!;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const path = (req.originalUrl || req.url || '').toLowerCase();

    // 1. Exempt routes: health checks, status endpoint, and bank / device integrations
    if (this.isExemptRoute(path)) {
      return true;
    }

    // 2. Mobile identification: X-App header ('staff' or 'parent')
    // Web admin requests and non-mobile integrations do not send X-App and are thus exempt.
    const rawAppHeader = req.headers['x-app'];
    const appHeader = (
      Array.isArray(rawAppHeader) ? rawAppHeader[0] : rawAppHeader
    )?.trim().toLowerCase();

    if (!appHeader || (appHeader !== 'staff' && appHeader !== 'parent')) {
      return true;
    }

    const app = appHeader === 'staff' ? AppType.STAFF : AppType.PARENT;

    // Platform: android | ios (defaults to android if omitted)
    const rawPlatformHeader = req.headers['x-app-platform'];
    const platformHeader = (
      Array.isArray(rawPlatformHeader) ? rawPlatformHeader[0] : rawPlatformHeader
    )?.trim().toLowerCase();
    const platform = platformHeader === 'ios' ? AppPlatform.IOS : AppPlatform.ANDROID;

    // Build: optional integer
    const rawBuildHeader = req.headers['x-app-build'];
    const buildHeader = Array.isArray(rawBuildHeader) ? rawBuildHeader[0] : rawBuildHeader;
    const build =
      buildHeader !== undefined && buildHeader !== null && buildHeader !== ''
        ? parseInt(String(buildHeader), 10)
        : undefined;

    // 3. Check access (maintenance and optional min build check)
    const service = this.getAppConfigService();
    const result = await service.checkAppAccess(app, platform, build);

    if (!result.allowed) {
      if (result.status === HttpStatus.SERVICE_UNAVAILABLE) {
        throw new HttpException(
          {
            code: result.code ?? 'MAINTENANCE',
            message:
              result.message ?? 'The app is currently under maintenance. Please try again later.',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      if (result.status === 426) {
        throw new HttpException(
          {
            code: result.code ?? 'UPGRADE_REQUIRED',
            message:
              result.message ??
              'A new version of the app is available. Please update to continue.',
            minBuildNumber: result.minBuildNumber,
            storeUrl: result.storeUrl,
          },
          426,
        );
      }

      throw new HttpException(
        {
          code: result.code ?? 'MAINTENANCE',
          message: result.message,
        },
        result.status ?? HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return true;
  }

  private isExemptRoute(path: string): boolean {
    const cleanPath = path.split('?')[0];

    // Status endpoint (e.g. /api/v1/app-config/status or /app-config/status)
    if (cleanPath.includes('/app-config/status')) {
      return true;
    }

    // Health probes (e.g. /healthz, /api/v1/healthz, /health)
    if (
      cleanPath.endsWith('/healthz') ||
      cleanPath.endsWith('/health') ||
      cleanPath === '/' ||
      cleanPath === '/api/v1'
    ) {
      return true;
    }

    // Bank and external integrations (UBL, Meezan, Bank accounts, ZKTeco iClock)
    if (
      cleanPath.includes('/ubl') ||
      cleanPath.includes('/meezan') ||
      cleanPath.includes('/bank-accounts') ||
      cleanPath.includes('/iclock')
    ) {
      return true;
    }

    // Web-admin /app-config management
    if (cleanPath.startsWith('/api/v1/app-config') && !cleanPath.includes('/status')) {
      return true;
    }

    return false;
  }
}
