import { IsString, IsOptional, IsBoolean, IsEnum } from 'class-validator';
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
}
