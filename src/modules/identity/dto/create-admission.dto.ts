import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsDateString,
  IsEnum,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  IsEmail,
  MaxLength,
  ValidateIf,
  Allow,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─── Enums ───────────────────────────────────────────────────────────────────

export enum Gender {
  Male = 'Male',
  Female = 'Female',
}

export enum AcademicSystem {
  Cambridge = 'Cambridge',
  Secondary = 'Secondary',
}

// ─── Sub-DTOs ────────────────────────────────────────────────────────────────

export class PreviousSchoolDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  school_name: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  location?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  class_studied_from?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  class_studied_to?: string;

  @IsString()
  @IsOptional()
  reason_for_leaving?: string;
}

export class AdditionalPhoneDto {
  @IsString()
  label: string;

  @IsString()
  number: string;
}

export class GuardianDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  full_name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(15)
  cnic?: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  primary_phone_country_code?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  primary_phone?: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  whatsapp_country_code?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  whatsapp_number?: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  work_phone_country_code?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  work_phone?: string;

  @IsEmail()
  @ValidateIf((o) => o.email_address !== 'N/A')
  @IsOptional()
  email_address?: string;

  @IsDateString()
  @IsOptional()
  dob?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  education_level?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  occupation?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  organization?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  job_position?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  occupational_position?: string;

  // Address fields (maps to mailing address on the form)
  @IsString()
  @IsOptional()
  @MaxLength(100)
  house_appt_name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  house_appt_number?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  area_block?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  city?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  province?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  country?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  postal_code?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  fax_number?: string;
  
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdditionalPhoneDto)
  @IsOptional()
  additional_phones?: AdditionalPhoneDto[];
}

export class StudentFlagDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  description: string;

  @IsOptional()
  @IsDateString()
  reminder_date?: string;
}

export class EmergencyContactDto {
  @IsString()
  @ValidateIf((o) => o.full_name !== 'N/A')
  @IsNotEmpty()
  @MaxLength(100)
  full_name: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  primary_phone_country_code?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  primary_phone: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  relationship: string;

  @IsString()
  @IsOptional()
  role?: 'father' | 'mother' | 'other';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdditionalPhoneDto)
  @IsOptional()
  additional_phones?: AdditionalPhoneDto[];
}

export class AdmissionDetailsDto {
  @IsEnum(AcademicSystem)
  academic_system: AcademicSystem;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  requested_grade: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  academic_year?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  discipline?: string;

  @IsOptional()
  @IsInt()
  campus_id?: number;

  @IsOptional()
  @IsInt()
  class_id?: number;

  @IsOptional()
  @IsInt()
  section_id?: number;
}

// ─── Root DTO ─────────────────────────────────────────────────────────────────

export class CreateAdmissionDto {
  // ── Existing family (sibling re-registration) ──
  @IsInt()
  @Min(1)
  @IsOptional()
  existing_family_id?: number;

  @IsBoolean()
  @IsOptional()
  should_create_family?: boolean;

  // ── Student personal data ──
  @IsString()
  @IsOptional()
  @MaxLength(50)
  gr_number?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  full_name: string;

  @IsDateString()
  dob: string;

  @IsEnum(Gender)
  gender: Gender;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  nationality?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  religion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  country?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  province?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  city?: string;

  @IsString()
  @IsOptional()
  identification_marks?: string;

  @IsString()
  @IsOptional()
  medical_info?: string;

  // Candidate contact
  @IsString()
  @IsOptional()
  @MaxLength(10)
  primary_phone_country_code?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  primary_phone?: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  whatsapp_country_code?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  whatsapp_number?: string;

  @IsEmail()
  @ValidateIf((o) => o.email !== 'N/A')
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  home_phone?: string;

  // ── Guardians ──
  @ValidateNested()
  @Type(() => GuardianDto)
  father: GuardianDto;

  @ValidateNested()
  @Type(() => GuardianDto)
  mother: GuardianDto;

  @ValidateNested()
  @IsOptional()
  @Type(() => EmergencyContactDto)
  emergency_contact?: EmergencyContactDto;

  // ── Admission details ──
  @ValidateNested()
  @Type(() => AdmissionDetailsDto)
  admission: AdmissionDetailsDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StudentFlagDto)
  @IsOptional()
  flags?: StudentFlagDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreviousSchoolDto)
  @IsOptional()
  previous_schools?: PreviousSchoolDto[];
}
