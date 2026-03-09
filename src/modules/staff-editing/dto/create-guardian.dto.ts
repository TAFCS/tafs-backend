import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsNumber,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateGuardianDto {
  // Required: guardian identity
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  full_name: string;

  // Required: how this guardian relates to the student (stored in student_guardians join table)
  @IsString()
  @IsNotEmpty()
  relationship: string;

  // Optional join-table flags
  @IsOptional()
  @IsBoolean()
  is_primary_contact?: boolean;

  @IsOptional()
  @IsBoolean()
  is_emergency_contact?: boolean;

  // Optional guardian identity fields
  @IsOptional()
  @IsString()
  @MaxLength(15)
  cnic?: string;

  @IsOptional()
  @IsString()
  dob?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  primary_phone_country_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  primary_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  whatsapp_country_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  whatsapp_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  work_phone_country_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  work_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  email_address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  education_level?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  occupation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  organization?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  job_position?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  monthly_income?: number;

  @IsOptional()
  @IsString()
  work_address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  house_appt_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  house_appt_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  area_block?: string;

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
  mailing_address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  occupational_position?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  place_of_birth?: string;

  @IsOptional()
  @IsString()
  cnic_pic_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  passport_front_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  passport_back_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  photo_url?: string;
}
