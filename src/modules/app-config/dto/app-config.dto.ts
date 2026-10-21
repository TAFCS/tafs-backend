import { IsString, IsNotEmpty, IsInt, IsEnum, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export enum AppPlatform {
  ANDROID = 'android',
  IOS = 'ios',
}

export enum AppType {
  STAFF = 'staff',
  PARENT = 'parent',
}

export class AppStatusQueryDto {
  @IsEnum(AppPlatform)
  platform: AppPlatform;

  @Type(() => Number)
  @IsInt()
  build: number;

  /**
   * Identifies the mobile application: 'staff' (com.tafsstaff.app) or 'parent' (com.tafs.app).
   * Optional for backwards compatibility with legacy client builds deployed without this param.
   * If omitted, defaults to 'parent' as the original mobile app.
   */
  @IsOptional()
  @IsEnum(AppType)
  app?: AppType;
}

export class UpdateAppConfigDto {
  @IsString()
  @IsNotEmpty()
  value: string;
}
