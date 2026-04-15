import { IsArray, ValidateNested, IsNumber, IsString, IsOptional, IsPositive, IsISO8601, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SaveStudentFeeItemDto {
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

    /** Net amount for this student (after specific override). */
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    @IsOptional()
    amount?: number;

    /** Exact date for this fee head — enables multiple vouchers per student per month. */
    @IsISO8601()
    @IsOptional()
    fee_date?: string;
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
