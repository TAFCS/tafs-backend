import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { OvertimeRateType } from '@prisma/client';

export class DecidePayrollFlagDto {
  @IsEnum(['APPLIED', 'EXEMPTED'])
  status: 'APPLIED' | 'EXEMPTED';
}

export class ExcludePayrollLineDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class SetFullPayDto {
  @IsBoolean()
  enabled: boolean;
}

/** TAFSD-383: omitted fields keep their current value. true = not charged this cycle. */
export class SetStatutoryWaiversDto {
  @IsOptional()
  @IsBoolean()
  eobi?: boolean;

  @IsOptional()
  @IsBoolean()
  sessi?: boolean;

  @IsOptional()
  @IsBoolean()
  income_tax?: boolean;
}

/**
 * TAFSD-436: the same switches for many lines at once. Omit employee_ids to
 * apply to every open (not finalized) line on the run.
 */
export class BulkStatutoryWaiversDto extends SetStatutoryWaiversDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsInt({ each: true })
  employee_ids?: number[];
}

export class DisbursePayrollLineDto {
  @IsOptional()
  @IsString()
  disbursed_at?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class OvertimeRewardDto {
  @IsEnum(OvertimeRateType)
  rate_type: OvertimeRateType;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  rate_amount: number;
}

/**
 * "Settling" one employee's pay is what used to be the plain "mark
 * disbursed" button — it still stamps disbursed_at/disbursed_by, but now
 * also optionally rewards overtime and records a cash bonus, and always
 * produces a payslip. See PayrollService#settleLine.
 */
export class SettlePayrollLineDto {
  @IsOptional()
  @IsString()
  disbursed_at?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OvertimeRewardDto)
  overtime?: OvertimeRewardDto;

  /**
   * Paid by hand, off the books, specifically to stay untracked for tax
   * purposes — recorded only for the school's own internal bookkeeping.
   * MUST NEVER be surfaced on the payslip or to the employee.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cash_bonus_amount?: number;
}
