import {
  IsString,
  IsOptional,
  IsDateString,
  IsNumber,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateGuardianDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  full_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(15)
  cnic?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  primary_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  whatsapp_number?: string;

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
}
