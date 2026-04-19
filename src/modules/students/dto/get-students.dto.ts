import { IsOptional, IsString, IsInt, Min, IsEnum, IsArray } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { StudentStatus } from '../../../constants/student-status.constant';

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
  house_id?: number;

  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;

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
}
