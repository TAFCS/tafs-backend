import {
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class ListSubjectsQueryDto {
  @IsOptional()
  @IsString()
  academic_system?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  active?: boolean;
}

export class CreateSubjectDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  academic_system?: string;
}

export class UpdateSubjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  academic_system?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class TimetableGridQueryDto {
  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @Type(() => Number)
  @IsInt()
  class_id: number;

  @Type(() => Number)
  @IsInt()
  section_id: number;

  @IsString()
  @MaxLength(10)
  academic_year: string;
}

export class DaySlotsQueryDto {
  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @Type(() => Number)
  @IsInt()
  class_id: number;

  @Type(() => Number)
  @IsInt()
  section_id: number;

  @IsString()
  date: string;
}

export class CreateTimetableDto {
  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @Type(() => Number)
  @IsInt()
  class_id: number;

  @Type(() => Number)
  @IsInt()
  section_id: number;

  @IsString()
  @MaxLength(10)
  academic_year: string;
}

export class GroupDaySlotsQueryDto {
  @Type(() => Number)
  @IsInt()
  teaching_group_id: number;

  @IsString()
  date: string;
}

export class TeachingGroupGridQueryDto {
  @Type(() => Number)
  @IsInt()
  teaching_group_id: number;

  @IsString()
  @MaxLength(10)
  academic_year: string;
}

export class CreateGroupTimetableDto {
  @Type(() => Number)
  @IsInt()
  teaching_group_id: number;

  @IsString()
  @MaxLength(10)
  academic_year: string;
}

export class UpsertSlotDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(6)
  day_of_week: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  block_number: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2)
  slot_order: number;

  @Type(() => Number)
  @IsInt()
  subject_id: number;

  @Type(() => Number)
  @IsInt()
  employee_id: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  room?: string;
}
