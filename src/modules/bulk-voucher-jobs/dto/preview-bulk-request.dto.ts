import { Type } from 'class-transformer';
import {
    IsBoolean,
    IsInt,
    IsISO8601,
    IsNotEmpty,
    IsOptional,
    IsString,
} from 'class-validator';

export class PreviewBulkRequestDto {
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

    /**
     * Academic year string e.g. "2024-2025".
     */
    @IsString()
    @IsOptional()
    academic_year?: string;

    /**
     * Start of the fee date range (inclusive). Used to check for already-issued vouchers
     * in the range and to determine which fee records to include.
     */
    @IsISO8601()
    @IsNotEmpty()
    fee_date_from: string;

    /**
     * End of the fee date range (inclusive).
     */
    @IsISO8601()
    @IsNotEmpty()
    fee_date_to: string;

    /**
     * Whether to flag students who already have a voucher in this date range.
     */
    @IsBoolean()
    @IsOptional()
    skip_already_issued?: boolean = true;
}
