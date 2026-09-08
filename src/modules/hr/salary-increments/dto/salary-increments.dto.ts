import { Transform, Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

/** Accept `?x=1,2,3`, repeated `?x=1&x=2`, or a single value; yields a number[] (or undefined). */
const toIntArray = ({ value }: { value: unknown }): number[] | undefined => {
  if (value == null || value === '') return undefined;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const nums = parts.map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n));
  return nums.length ? nums : undefined;
};

const toStringArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (value == null || value === '') return undefined;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const strs = parts.map((v) => String(v).trim()).filter(Boolean);
  return strs.length ? strs : undefined;
};

export class UpdateSalaryIncrementSettingsDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(120) default_cycle_months: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(365) upcoming_window_days: number;
}

export class SalaryIncrementApplyDto {
  @IsArray() @ArrayMinSize(1) @IsInt({ each: true }) employee_ids: number[];
  @IsIn(['PERCENTAGE', 'FIXED_AMOUNT']) mode: 'PERCENTAGE' | 'FIXED_AMOUNT';
  @ValidateIf(o => o.mode === 'PERCENTAGE') @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.01) percentage?: number;
  @ValidateIf(o => o.mode === 'FIXED_AMOUNT') @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) fixed_amount?: number;
  @IsDateString() effective_from: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class DueSalaryIncrementsQueryDto {
  @IsOptional() @IsIn(['due', 'upcoming', 'all']) status?: 'due' | 'upcoming' | 'all';
  @IsOptional() @Transform(toIntArray) @IsArray() @IsInt({ each: true }) campus_ids?: number[];
  @IsOptional() @Transform(toIntArray) @IsArray() @IsInt({ each: true }) department_ids?: number[];
  @IsOptional() @Transform(toIntArray) @IsArray() @IsInt({ each: true }) segment_ids?: number[];
  @IsOptional() @Transform(toIntArray) @IsArray() @IsInt({ each: true }) staff_category_ids?: number[];
  @IsOptional() @Transform(toStringArray) @IsArray() @IsString({ each: true }) employment_types?: string[];
  @IsOptional() @IsString() search?: string;
}

export class UpdateEmployeeIncrementCycleDto {
  // null clears the override (fall back to the org default); a number is range-checked.
  @IsOptional() @ValidateIf((_, value) => value !== null) @Type(() => Number) @IsInt() @Min(1) @Max(120) increment_cycle_months?: number | null;
}
