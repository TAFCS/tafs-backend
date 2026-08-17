import {
  IsArray,
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
import { fee_status_enum } from '@prisma/client';
import {
  toNumberArray,
  toStringArray,
} from '../../../common/transforms/query-array.transform';

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
  @IsIn(['heads', 'student'])
  view?: 'heads' | 'student';
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
