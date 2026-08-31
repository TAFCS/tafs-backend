import {
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class EligibleSlotsQueryDto {
  @Type(() => Number)
  @IsInt()
  teaching_group_id: number;

  @IsDateString()
  makeup_date: string;
}

export class SourceDateHoldStatusQueryDto {
  @Type(() => Number)
  @IsInt()
  teaching_group_id: number;

  /** Comma-separated timetable slot ids, e.g. "12,15" */
  @IsString()
  source_timetable_slot_ids: string;

  /** Comma-separated ISO dates, e.g. "2026-08-22,2026-08-29" */
  @IsString()
  dates: string;
}

export class ListClassReschedulesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  teaching_group_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campus_id?: number;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  status?: string;
}

export class RescheduleSourceItemDto {
  @Type(() => Number)
  @IsInt()
  source_timetable_slot_id: number;

  @IsDateString()
  source_date: string;
}

export class CreateClassRescheduleDto {
  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @Type(() => Number)
  @IsInt()
  class_id: number;

  @Type(() => Number)
  @IsInt()
  teaching_group_id: number;

  /** One or more original slots being covered by this makeup session. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RescheduleSourceItemDto)
  sources?: RescheduleSourceItemDto[];

  /** @deprecated Use sources[] — kept for backward compatibility */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  source_timetable_slot_id?: number;

  /** @deprecated Use sources[] */
  @IsOptional()
  @IsDateString()
  source_date?: string;

  @IsDateString()
  makeup_date: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  makeup_period: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  makeup_timetable_slot_id?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateRescheduleMakeupDto {
  @IsDateString()
  makeup_date: string;
}
