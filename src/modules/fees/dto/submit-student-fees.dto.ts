import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsPositive,
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
  @IsInt()
  @IsPositive()
  student_id: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeeLineItemDto)
  items: FeeLineItemDto[];
}
