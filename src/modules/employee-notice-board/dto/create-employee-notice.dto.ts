import {
  IsString,
  IsOptional,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';

export class CreateEmployeeNoticeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @IsString()
  body: string;

  @ApiPropertyOptional({ enum: StaffRole, isArray: true, description: 'Empty array = all roles' })
  @IsOptional()
  @IsArray()
  @IsEnum(StaffRole, { each: true })
  target_roles?: StaffRole[];

  @ApiPropertyOptional({ description: 'Empty array = all campuses' })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  campus_ids?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media_urls?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media_types?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_pinned?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expires_at?: string;
}
