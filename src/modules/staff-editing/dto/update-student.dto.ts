import {
  IsOptional,
  IsString,
  IsInt,
  IsBoolean,
  IsEnum,
  IsDateString,
  IsArray,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** TAFSD-475: one special category on the student, by its School Setup code. */
export class StudentCategoryInputDto {
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/)
  code: string;

  /** false takes the category off the student. */
  @IsBoolean()
  on: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @IsOptional()
  @IsDateString()
  until?: string | null;

  /** The home reminder starts on this date. */
  @IsOptional()
  @IsDateString()
  remind_from?: string | null;
}
import { StudentStatus } from '../../../constants/student-status.constant';

export class UpdateStudentDto {
  // Bio fields
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
  @MaxLength(100)
  place_of_birth?: string;

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
  gr_number?: string | null;

  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;

  @IsOptional()
  @IsDateString()
  doa?: string;

  /**
   * TAFSD-475: special categories to change. Categories not listed are left
   * as they are. Replaces the per-category fields below, which older webapp
   * builds still send (they map onto the same five categories).
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StudentCategoryInputDto)
  categories?: StudentCategoryInputDto[];

  /** @deprecated TAFSD-475: use `categories`. */
  @IsOptional()
  @IsBoolean()
  is_complementary?: boolean;

  @IsOptional()
  @IsBoolean()
  is_fee_endowment?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  complementary_reason?: string | null;

  @IsOptional()
  @IsDateString()
  complementary_until?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  fee_endowment_reason?: string | null;

  @IsOptional()
  @IsDateString()
  fee_endowment_until?: string | null;

  @IsOptional()
  @IsBoolean()
  is_fee_endowment_mtf?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  fee_endowment_mtf_reason?: string | null;

  @IsOptional()
  @IsDateString()
  fee_endowment_mtf_until?: string | null;

  @IsOptional()
  @IsBoolean()
  is_sehm_e_sadaat?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  sehm_e_sadaat_reason?: string | null;

  @IsOptional()
  @IsDateString()
  sehm_e_sadaat_until?: string | null;

  @IsOptional()
  @IsBoolean()
  is_sehm_e_imam?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  sehm_e_imam_reason?: string | null;

  @IsOptional()
  @IsDateString()
  sehm_e_imam_until?: string | null;

  /** TAFSD-455: the home reminder starts on this date. */
  @IsOptional()
  @IsDateString()
  fee_endowment_remind_from?: string | null;

  /** TAFSD-455: the home reminder starts on this date. */
  @IsOptional()
  @IsDateString()
  complementary_remind_from?: string | null;

  /** TAFSD-455: the home reminder starts on this date. */
  @IsOptional()
  @IsDateString()
  fee_endowment_mtf_remind_from?: string | null;

  /** TAFSD-455: the home reminder starts on this date. */
  @IsOptional()
  @IsDateString()
  sehm_e_sadaat_remind_from?: string | null;

  /** TAFSD-455: the home reminder starts on this date. */
  @IsOptional()
  @IsDateString()
  sehm_e_imam_remind_from?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  fee_start_term?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  graduated_from_class_id?: number;

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

  @IsOptional()
  @IsString()
  photograph_url?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  discipline?: string | null;

  @IsOptional()
  @IsString()
  photo_blue_bg_url?: string | null;
}
