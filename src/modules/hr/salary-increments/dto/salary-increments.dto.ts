import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

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
  @IsOptional() @Type(() => Number) @IsInt() campus_id?: number;
  @IsOptional() @Type(() => Number) @IsInt() department_id?: number;
  @IsOptional() @Type(() => Number) @IsInt() segment_id?: number;
  @IsOptional() @Type(() => Number) @IsInt() class_id?: number;
  @IsOptional() @IsString() search?: string;
}

export class UpdateEmployeeIncrementCycleDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(120) increment_cycle_months?: number | null;
}
