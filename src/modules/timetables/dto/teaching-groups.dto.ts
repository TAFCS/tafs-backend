import { IsArray, IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class ListTeachingGroupsQueryDto {
  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @Type(() => Number)
  @IsInt()
  class_id: number;

  @IsString()
  @MaxLength(10)
  academic_year: string;
}

export class CreateTeachingGroupDto {
  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @Type(() => Number)
  @IsInt()
  class_id: number;

  @Type(() => Number)
  @IsInt()
  subject_id: number;

  @Type(() => Number)
  @IsInt()
  employee_id: number;

  @IsString()
  @MaxLength(10)
  academic_year: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}

export class UpdateTeachingGroupDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employee_id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class BulkEnrollDto {
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  student_ids: number[];

  @IsString()
  @MaxLength(10)
  academic_year: string;
}
