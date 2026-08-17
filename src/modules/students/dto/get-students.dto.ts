import { IsOptional, IsString, IsInt, Min, IsEnum, IsArray, IsIn } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { StudentStatus } from '../../../constants/student-status.constant';
import { toNumberArray, toStringArray } from '../../../common/transforms/query-array.transform';

// Accepts every real student status plus "UNCONFIRMED" as an alias for QUICK_ADMISSION.
export const STUDENT_LIST_STATUSES = [...Object.values(StudentStatus), 'UNCONFIRMED'] as const;
export type StudentListStatus = (typeof STUDENT_LIST_STATUSES)[number];

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
  @IsEnum([
    'missing_guardian',
    'no_family',
    'no_house',
    'abnormal',
    'no_biometric',
    'has_biometric',
  ])
  audit_type?:
    | 'missing_guardian'
    | 'no_family'
    | 'no_house'
    | 'abnormal'
    | 'no_biometric'
    | 'has_biometric';

  @IsOptional()
  @IsEnum(['true', 'false'])
  has_photo?: 'true' | 'false';

  @IsOptional()
  @IsEnum(['true', 'false'])
  had_quick_admission?: 'true' | 'false';

  @IsOptional()
  @IsString()
  columns?: string;
}
