import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RollRecordStatus } from '@prisma/client';

export class ListRollSessionsQueryDto {
  @IsDateString()
  date: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campus_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  class_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  section_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  period?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  timetable_slot_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  teaching_group_id?: number;
}

export class CreateRollSessionDto {
  @IsDateString()
  session_date: string;

  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @Type(() => Number)
  @IsInt()
  class_id: number;

  /** Required unless teaching_group_id is provided (mutually exclusive scope). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  section_id?: number;

  /** Required unless section_id is provided. When set, the roster is the
   * teaching group's enrolled students instead of the whole section. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  teaching_group_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  period?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  timetable_slot_id?: number;
}

export class RollRecordMarkDto {
  @Type(() => Number)
  @IsInt()
  student_cc: number;

  @IsEnum(RollRecordStatus)
  status: RollRecordStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateRollSessionDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RollRecordMarkDto)
  records?: RollRecordMarkDto[];

  @IsOptional()
  @IsBoolean()
  submit?: boolean;
}

export class SkipRollSessionDto {
  @IsString()
  reason: string;
}
