import { IsString, IsNotEmpty, IsInt, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export enum AppPlatform {
  ANDROID = 'android',
  IOS = 'ios',
}

export class AppStatusQueryDto {
  @IsEnum(AppPlatform)
  platform: AppPlatform;

  @Type(() => Number)
  @IsInt()
  build: number;
}

export class UpdateAppConfigDto {
  @IsString()
  @IsNotEmpty()
  value: string;
}
