import { IsArray, ValidateNested, IsNumber, IsString, IsOptional, IsPositive, IsISO8601, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class SaveStudentFeeItemDto {
    /**
     * Existing student_fees.id this row maps to. When present it IS the row's
     * identity — the composite (fee_type_id|target_month|academic_year|fee_date)
     * key is only a fallback for rows the client can't tag yet (rows the user
     * just added in the grid). Sending it is what makes editing fee_date a MOVE
     * of the existing head rather than a delete-and-recreate, which is how a
     * date edit used to lose description_prefix/split_pair_id — or, when the old
     * row couldn't be deleted, leave a duplicate behind.
     */
    @IsNumber()
    @IsOptional()
    id?: number;

    @IsNumber()
    fee_type_id: number;

    @IsNumber()
    @IsOptional()
    month?: number;

    @IsNumber()
    @IsOptional()
    target_month?: number;

    @IsString()
    academic_year: string;

    /** Gross price for this fee before any student-specific discount is applied (template price). */
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    amount_before_discount: number;

    /**
     * Net amount for this student after the system discount override —
     * i.e. the amount BEFORE any scholarship. Stored as amount_after_discount;
     * the final `amount` (after scholarship, if any) is computed server-side.
     */
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    @IsOptional()
    amount?: number;

    /** Exact date for this fee head — enables multiple vouchers per student per month. */
    @IsISO8601()
    @IsOptional()
    fee_date?: string;

    /** Scholarship percentage (0-100) applied on top of amount_after_discount. MTF (fee_type_id=1) only. */
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    @Max(100)
    @IsOptional()
    scholarship_percentage?: number;

    /** Existing scholarship_presets.id — mutually exclusive with scholarship_custom_title. */
    @IsNumber()
    @IsOptional()
    scholarship_type_id?: number;

    /** Free-text title used to create a new scholarship preset on the fly. */
    @IsString()
    @IsOptional()
    scholarship_custom_title?: string;
}

export class SaveStudentFeeBundleDto {
    @IsString()
    bundle_name: string;

    @IsNumber()
    @IsOptional()
    target_month?: number;

    @IsString()
    academic_year: string;

    /** Array of `${fee_type_id}|${target_month}` strings to identify which fees belong in this bundle. */
    @IsArray()
    @IsString({ each: true })
    fee_keys: string[];
}

export class BulkSaveStudentFeesDto {
    @IsNumber()
    student_id: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SaveStudentFeeItemDto)
    items: SaveStudentFeeItemDto[];

    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => SaveStudentFeeBundleDto)
    bundles?: SaveStudentFeeBundleDto[];

    @IsString()
    @IsOptional()
    academic_year?: string;
}
