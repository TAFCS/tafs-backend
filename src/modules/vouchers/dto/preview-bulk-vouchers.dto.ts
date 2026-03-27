import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class PreviewBulkVouchersDto {
    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    campus_id: number;

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    class_id?: number;

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    section_id?: number;

    @IsString()
    @IsNotEmpty()
    academic_year: string;

    /**
     * Legacy month-based targeting (1-12). Either `month` or `fee_date`
     * must be provided, but not necessarily both.
     */
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(12)
    @IsOptional()
    month?: number;

    /**
     * Exact fee date (ISO 8601). When provided, fees and duplicate-check
     * are resolved by this date instead of `month`, allowing multiple
     * vouchers per student in the same calendar month.
     */
    @IsISO8601()
    @IsOptional()
    fee_date?: string;

    @IsISO8601()
    @IsNotEmpty()
    issue_date: string;

    @IsISO8601()
    @IsNotEmpty()
    due_date: string;

    @IsISO8601()
    @IsOptional()
    validity_date?: string;

    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    bank_account_id: number;
}
