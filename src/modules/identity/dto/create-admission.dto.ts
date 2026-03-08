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

export class GuardianDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  full_name: string;

  @IsString()
  @IsOptional()
  @MaxLength(15)
  cnic?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  primary_phone?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  whatsapp_number?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  work_phone?: string;

  @IsEmail()
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
}

export class EmergencyContactDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  full_name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  primary_phone: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  relationship: string;
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
}

// ─── Root DTO ─────────────────────────────────────────────────────────────────

export class CreateAdmissionDto {
  // ── Existing family (sibling re-registration) ──
  @IsInt()
  @Min(1)
  @IsOptional()
  existing_family_id?: number;

  // ── Student personal data ──
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
  @MaxLength(20)
  primary_phone?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  whatsapp_number?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

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

  // ── Previous schools ──
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreviousSchoolDto)
  @IsOptional()
  previous_schools?: PreviousSchoolDto[];
}
