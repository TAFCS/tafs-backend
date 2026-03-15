import { Type } from 'class-transformer';
import {
  IsArray,
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

  @IsString()
  @IsNotEmpty()
  academic_year: string;

  /** Gross price for this fee before any discount is applied. Stored on the
   *  student_fees record so the original scheduled amount is always visible. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount_before_discount: number;
}

export class SubmitStudentFeesDto {
  /** Student CC (integer primary key) */
  @IsInt()
  @IsNotEmpty()
  cc: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeeLineItemDto)
  items: FeeLineItemDto[];
}
