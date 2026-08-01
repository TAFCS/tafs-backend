import { IsOptional, IsString, IsInt, Min, IsEnum, IsArray, IsIn } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { StudentStatus } from '../../../constants/student-status.constant';

// Accepts every real student status plus "UNCONFIRMED" as an alias for QUICK_ADMISSION.
export const STUDENT_LIST_STATUSES = [...Object.values(StudentStatus), 'UNCONFIRMED'] as const;
export type StudentListStatus = (typeof STUDENT_LIST_STATUSES)[number];

/** Accepts a single value, comma-separated string, or array → number[]. */
function toNumberArray({ value }: { value: unknown }): number[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const nums = raw
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isInteger(n) && !Number.isNaN(n));
  return nums.length ? nums : undefined;
}

/** Accepts a single value, comma-separated string, or array → string[]. */
function toStringArray({ value }: { value: unknown }): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const items = raw.map((v) => String(v).trim()).filter(Boolean);
  return items.length ? items : undefined;
}

export class GetStudentsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  campus_id?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  class_id?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  section_id?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  house_id?: number[];

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsIn(STUDENT_LIST_STATUSES as unknown as string[], { each: true })
  status?: StudentListStatus[];

  @IsOptional()
  @IsArray()
  @IsEnum(['core', 'academic', 'family', 'contact', 'demographic', 'medical', 'history'], { each: true })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((v) => v.trim());
    }
    return value;
  })
  fields?: ('core' | 'academic' | 'family' | 'contact' | 'demographic' | 'medical' | 'history')[];

  @IsOptional()
  @IsString()
  is_abnormal?: string;

  @IsOptional()
  @IsEnum(['missing_guardian', 'no_family', 'abnormal'])
  audit_type?: 'missing_guardian' | 'no_family' | 'abnormal';

  @IsOptional()
  @IsEnum(['true', 'false'])
  has_photo?: 'true' | 'false';

  @IsOptional()
  @IsString()
  columns?: string;
}
