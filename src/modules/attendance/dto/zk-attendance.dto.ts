import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsISO8601, IsInt, IsOptional, IsString } from 'class-validator';
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


export class SimulateScanDto {
  @IsString()
  device_sn: string;

  @IsString()
  device_pin: string;

  @IsOptional()
  @IsISO8601()
  scan_time?: string;
}
