import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * TAFSD-560: the bodies of POST /staff-editing/students/:id/{admissions,
 * activities,languages,schools}. Each saves one row of the student in the
 * path: with `id`, that row (it must belong to this student), without, a new
 * one. Typed so nothing else in the body reaches the database.
 */
class StudentRecordDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  id?: number;
}

export class UpsertAdmissionDto extends StudentRecordDto {
  @IsOptional() @IsString() @MaxLength(20)
  academic_system?: string;

  @IsOptional() @IsString() @MaxLength(20)
  requested_grade?: string;

  @IsOptional() @IsString() @MaxLength(10)
  academic_year?: string;

  @IsOptional() @IsString() @MaxLength(50)
  discipline?: string | null;

  /** YYYY-MM-DD; empty means today. */
  @IsOptional() @IsString() @MaxLength(30)
  application_date?: string;
}

export class UpsertActivityDto extends StudentRecordDto {
  @IsOptional() @IsString() @MaxLength(100)
  activity_name?: string;

  @IsOptional() @IsString() @MaxLength(20)
  grade?: string;

  @IsOptional() @IsString()
  honors_awards?: string;

  @IsOptional() @IsBoolean()
  continue_at_tafs?: boolean;
}

export class UpsertLanguageDto extends StudentRecordDto {
  @IsOptional() @IsString() @MaxLength(50)
  language_name?: string;

  @IsOptional() @IsBoolean()
  can_speak?: boolean;

  @IsOptional() @IsBoolean()
  can_read?: boolean;

  @IsOptional() @IsBoolean()
  can_write?: boolean;
}

export class UpsertPreviousSchoolDto extends StudentRecordDto {
  @IsOptional() @IsString() @MaxLength(100)
  school_name?: string;

  @IsOptional() @IsString() @MaxLength(100)
  location?: string;

  @IsOptional() @IsString() @MaxLength(20)
  class_studied_from?: string;

  @IsOptional() @IsString() @MaxLength(20)
  class_studied_to?: string;

  @IsOptional() @IsString()
  reason_for_leaving?: string;
}
