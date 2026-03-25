import {
  IsOptional,
  IsString,
  IsInt,
  IsBoolean,
  IsEnum,
  IsDateString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { StudentStatus } from '../../../constants/student-status.constant';

export class UpdateStudentDto {
  // Bio fields
  @IsOptional()
  @IsString()
  @MaxLength(100)
  full_name?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  gender?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  nationality?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  religion?: string;

  @IsOptional()
  @IsString()
  identification_marks?: string;

  @IsOptional()
  @IsString()
  medical_info?: string;

  @IsOptional()
  @IsString()
  interests?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  admission_age_years?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  city?: string;

  @IsOptional()
  @IsString()
  physical_impairment?: string;

  @IsOptional()
  @IsBoolean()
  consent_publicity?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  whatsapp_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  whatsapp_country_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  primary_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  primary_phone_country_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  email?: string;

  // Assignment fields
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
  @IsString()
  @MaxLength(10)
  academic_year?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  gr_number?: string;

  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;

  // Virtual fields for Parent Info (handled in service)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  father_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(15)
  father_cnic?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mother_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(15)
  mother_cnic?: string;
}
