import { IsString, IsNotEmpty, IsOptional, IsEnum, IsArray, IsInt } from 'class-validator';
import { Type } from 'class-transformer';
import { StaffRole } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  full_name: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsEnum(StaffRole)
  role: StaffRole;

  @IsOptional()
  @IsString()
  campus_id?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  allowed_class_ids?: number[];
}
