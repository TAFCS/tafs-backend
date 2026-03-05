import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class FeeLineItemDto {
  @IsInt()
  fee_type_id: number;

  /** Calendar month 1–12 */
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  /** Final resolved amount (may be overridden from base) */
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  /** ISO date string, first of the month: "YYYY-MM-01" */
  @IsDateString()
  due_date: string;
}

export class SubmitStudentFeesDto {
  /** Student CC number e.g. "CC-2026-00003" */
  @IsString()
  @IsNotEmpty()
  cc_number: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeeLineItemDto)
  items: FeeLineItemDto[];
}
