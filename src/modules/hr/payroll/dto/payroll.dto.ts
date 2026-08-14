import { ArrayNotEmpty, IsArray, IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { toNumberArray } from '../../../../common/transforms/query-array.transform';

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

  /**
   * Presence of this field is what makes a run a TEST run — scoped to just
   * these employees (instead of every paid employee on the campus), free to
   * delete/regenerate even after finalizing, and stored in a separate
   * (campus_id, period_start, period_end, is_test) slot so it never collides
   * with the real campus run for the same period.
   */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Type(() => Number)
  employee_ids?: number[];
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

  // Omitted -> every department on the resolved campuses. Narrowing here cuts
  // the work in computeEmployeeLinesForRange, not just the rendered row count.
  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  department_id?: number[];

  @IsDateString()
  period_start: string;

  @IsDateString()
  period_end: string;
}
