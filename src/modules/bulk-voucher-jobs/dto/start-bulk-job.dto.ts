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
    @IsInt({ each: true })
    @IsOptional()
    campus_ids?: number[];

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    campus_id?: number;

    @Type(() => Number)
    @IsInt({ each: true })
    @IsOptional()
    class_ids?: number[];

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    class_id?: number;

    @Type(() => Number)
    @IsInt({ each: true })
    @IsOptional()
    section_ids?: number[];

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
    @IsOptional()
    bank_account_id?: number;

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

    /**
     * Whether each voucher produced by this job pushes an instant "voucher issued"
     * alert to the family. Defaults to true; an explicit `false` suppresses only the
     * instant push, not the scheduled due/overdue/expiry reminders.
     */
    @IsBoolean()
    @IsOptional()
    send_notification?: boolean;

    /**
     * When true, every voucher this job produces is held from parents until an
     * admin releases the batch. Default (omitted/false) matches today's behaviour.
     */
    @IsBoolean()
    @IsOptional()
    hold_for_release?: boolean;

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
    @IsString()
    @IsOptional()
    job_type?: string;

    @IsArray()
    @IsInt({ each: true })
    @ArrayMinSize(1)
    student_ccs: number[];
}
