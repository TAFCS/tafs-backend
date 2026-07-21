import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * The payroll period is always the fixed school cycle — 26th of the
 * previous month through the 25th of `month` — so callers pick the payroll
 * month/year rather than typing dates. e.g. month=7,year=2026 -> 26 Jun to
 * 25 Jul 2026. There is no override: this cycle is policy, not a default.
 */
export class GeneratePayrollRunDto {
  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ListPayrollRunsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campus_id?: number;
}

export class AttendanceMatrixQueryDto {
  // Omitted -> all employees across every campus the caller can see (see
  // PayrollService#resolveMatrixCampusIds).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campus_id?: number;

  @IsDateString()
  period_start: string;

  @IsDateString()
  period_end: string;
}
