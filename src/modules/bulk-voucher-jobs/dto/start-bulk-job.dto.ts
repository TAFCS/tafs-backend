import { Type } from 'class-transformer';
import {
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsInt,
    IsISO8601,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
} from 'class-validator';

export class StartBulkJobDto {
    // ── Scope ──────────────────────────────────────────────────────────────
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
    @IsOptional()
    academic_year?: string;

    // ── Date range ─────────────────────────────────────────────────────────
    @IsISO8601()
    @IsNotEmpty()
    fee_date_from: string;

    @IsISO8601()
    @IsNotEmpty()
    fee_date_to: string;

    @IsISO8601()
    @IsNotEmpty()
    issue_date: string;

    @IsISO8601()
    @IsNotEmpty()
    due_date: string;

    @IsISO8601()
    @IsOptional()
    validity_date?: string;

    // ── Bank ───────────────────────────────────────────────────────────────
    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    bank_account_id: number;

    // ── Flags ──────────────────────────────────────────────────────────────
    @IsBoolean()
    @IsOptional()
    skip_already_issued?: boolean;

    @IsBoolean()
    @IsOptional()
    waive_surcharge?: boolean;

    @IsBoolean()
    @IsOptional()
    apply_late_fee?: boolean;

    @Type(() => Number)
    @IsNumber()
    @IsOptional()
    late_fee_amount?: number;

    // ── Confirmed student list (from Step 2 preview) ───────────────────────
    /**
     * Explicit CC list confirmed by the admin after preview.
     * The pipeline operates on exactly these students — not the scope
     * filters — to prevent race conditions.
     */
    @IsArray()
    @IsInt({ each: true })
    @ArrayMinSize(1)
    student_ccs: number[];
}
