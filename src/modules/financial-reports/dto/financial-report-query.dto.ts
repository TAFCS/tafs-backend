import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { fee_status_enum, student_status } from '@prisma/client';
import {
  toNumberArray,
  toStringArray,
} from '../../../common/transforms/query-array.transform';
import { SEVERITY_BAND_IDS, SeverityBand } from '../defaulter-severity';

function toOptionalBoolean({ value }: { value: unknown }): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value as boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class FinancialReportQueryDto {
  @IsDateString()
  @Matches(DATE_ONLY, { message: 'from_date must be YYYY-MM-DD' })
  from_date: string;

  @IsDateString()
  @Matches(DATE_ONLY, { message: 'to_date must be YYYY-MM-DD' })
  to_date: string;

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
  segment_id?: number[];

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsEnum(student_status, { each: true })
  student_status?: student_status[];

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  is_fee_endowment?: boolean;

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  is_complementary?: boolean;

  /** Filter by the class the student graduated from (students.graduated_from_class_id). */
  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  graduated_from_class_id?: number[];

  /** Graduation academic-year range, "YYYY-YYYY" — see buildGraduationFilterWhere. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, { message: 'graduated_year_range must be in YYYY-YYYY format' })
  graduated_year_range?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}

export class ListFeeHeadsQueryDto extends FinancialReportQueryDto {
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsEnum(fee_status_enum, { each: true })
  status?: fee_status_enum[];

  @IsOptional()
  @IsIn(['heads', 'student', 'fee_type', 'period', 'class'])
  view?: 'heads' | 'student' | 'fee_type' | 'period' | 'class';
}

export class ListDepositsQueryDto extends FinancialReportQueryDto {
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  payment_method?: string[];

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  bank_name?: string[];
}

export class ExportFeeHeadsQueryDto extends ListFeeHeadsQueryDto {
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';
}

export class ExportDepositsQueryDto extends ListDepositsQueryDto {
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';
}

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class ListFeeMatrixQueryDto {
  @IsString()
  @Matches(YEAR_MONTH, { message: 'from_month must be YYYY-MM' })
  from_month: string;

  @IsString()
  @Matches(YEAR_MONTH, { message: 'to_month must be YYYY-MM' })
  to_month: string;

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
  segment_id?: number[];

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsEnum(student_status, { each: true })
  student_status?: student_status[];

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  is_fee_endowment?: boolean;

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  is_complementary?: boolean;

  /** Filter by the class the student graduated from (students.graduated_from_class_id). */
  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  graduated_from_class_id?: number[];

  /** Graduation academic-year range, "YYYY-YYYY" — see buildGraduationFilterWhere. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, { message: 'graduated_year_range must be in YYYY-YYYY format' })
  graduated_year_range?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cc?: number;

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsEnum(fee_status_enum, { each: true })
  status?: fee_status_enum[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 25;
}

export class ExportFeeMatrixQueryDto extends ListFeeMatrixQueryDto {
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';
}

/**
 * The campus/class/section/segment/status/graduation scope block shared by every
 * financial report, lifted out so the Defaulters report reuses one definition
 * instead of adding a third copy.
 *
 * FinancialReportQueryDto and ListFeeMatrixQueryDto still declare these fields
 * themselves and are NOT re-parented here — that would be a behaviour-neutral
 * refactor of three live reports for no gain in this change. They remain
 * structurally assignable to this type, which is all buildStudentWhere needs.
 */
export class StudentScopeFilterQueryDto {
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
  segment_id?: number[];

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsEnum(student_status, { each: true })
  student_status?: student_status[];

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  is_fee_endowment?: boolean;

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  is_complementary?: boolean;

  /** Filter by the class the student graduated from (students.graduated_from_class_id). */
  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  graduated_from_class_id?: number[];

  /** Graduation academic-year range, "YYYY-YYYY" — see buildGraduationFilterWhere. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, { message: 'graduated_year_range must be in YYYY-YYYY format' })
  graduated_year_range?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}

export type DefaulterView = 'students' | 'by_class' | 'by_campus' | 'aging';
export type DefaulterSortField =
  | 'months_behind'
  | 'arrears_outstanding'
  | 'oldest_arrear'
  | 'arrear_head_count'
  | 'student_name';

/**
 * Deliberately not extending FinancialReportQueryDto: its from_date/to_date are
 * required and meaningless here. The Defaulters report is "as of a date", not a
 * date range.
 */
export class ListDefaultersQueryDto extends StudentScopeFilterQueryDto {
  /**
   * Cutoff, mirroring computeArrears' targetFeeDate: heads with fee_date
   * STRICTLY BEFORE this date count as arrears. A head dated exactly
   * as_of_date does not. Defaults to today.
   */
  @IsOptional()
  @IsDateString()
  @Matches(DATE_ONLY, { message: 'as_of_date must be YYYY-MM-DD' })
  as_of_date?: string;

  /** Width of the payment-history strip, in calendar months ending at as_of_date's month. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  strip_months?: number = 12;

  @IsOptional()
  @IsIn(['students', 'by_class', 'by_campus', 'aging'])
  view?: DefaulterView;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  min_months_behind?: number = 1;

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsIn(SEVERITY_BAND_IDS, { each: true })
  severity?: SeverityBand[];

  /**
   * Excludes lps_outstanding and last_payment on purpose: sorting runs over the
   * whole filtered set before pagination, but those two are only computed for
   * the page slice. Offering them would mean LPS and deposit aggregates for
   * every scoped student on every request.
   */
  @IsOptional()
  @IsIn([
    'months_behind',
    'arrears_outstanding',
    'oldest_arrear',
    'arrear_head_count',
    'student_name',
  ])
  sort_by?: DefaulterSortField;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort_dir?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cc?: number;
}

export class ExportDefaultersQueryDto extends ListDefaultersQueryDto {
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';
}
