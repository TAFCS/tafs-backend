import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class ListStaffLessonTeachersQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  campus_id!: number;

  @IsOptional()
  @IsString()
  academic_year?: string;

  @IsOptional()
  @IsString()
  search?: string;
}

export class TeacherSlotsQueryDto {
  @IsOptional()
  @IsString()
  academic_year?: string;
}

export class ListStaffLessonReschedulesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campus_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employee_id?: number;

  @IsOptional()
  @IsString()
  status?: 'PENDING' | 'COMPLETED' | 'CANCELLED';

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class CreateStaffLessonRescheduleDto {
  @Type(() => Number)
  @IsInt()
  employee_id!: number;

  @Type(() => Number)
  @IsInt()
  campus_id!: number;

  @Type(() => Number)
  @IsInt()
  class_id!: number;

  @Type(() => Number)
  @IsInt()
  section_id!: number;

  @Type(() => Number)
  @IsInt()
  source_timetable_slot_id!: number;

  @IsDateString()
  source_date!: string;

  @IsDateString()
  makeup_date!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  makeup_timetable_slot_id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class StaffLessonSourceDateStatusQueryDto {
  @Type(() => Number)
  @IsInt()
  employee_id!: number;

  @Type(() => Number)
  @IsInt()
  source_timetable_slot_id!: number;

  @IsDateString()
  source_date!: string;
}
