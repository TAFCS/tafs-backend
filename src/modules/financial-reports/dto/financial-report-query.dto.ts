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
