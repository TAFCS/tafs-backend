import { IsString, IsOptional, IsBoolean, IsEnum, IsArray, IsInt } from 'class-validator';
import { Type } from 'class-transformer';
import { StaffRole } from '@prisma/client';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  full_name?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsEnum(StaffRole)
  role?: StaffRole;

  @IsOptional()
  @IsString()
  campus_id?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  allowed_class_ids?: number[];
}
