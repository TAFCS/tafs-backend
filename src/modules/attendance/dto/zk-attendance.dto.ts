import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { DevicePersonType } from '@prisma/client';

export class CreateDeviceMappingDto {
  @IsString()
  device_sn: string;

  @IsString()
  device_pin: string;

  @IsEnum(DevicePersonType)
  person_type: DevicePersonType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employee_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  student_cc?: number;

  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateDeviceMappingDto {
  @IsOptional()
  @IsEnum(DevicePersonType)
  person_type?: DevicePersonType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employee_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  student_cc?: number;

  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class SearchPersonsQueryDto {
  @IsEnum(DevicePersonType)
  type: DevicePersonType;

  @IsOptional()
  @IsString()
  q?: string;
}
