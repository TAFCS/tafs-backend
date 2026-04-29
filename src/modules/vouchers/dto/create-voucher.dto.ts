import { IsArray, IsBoolean, IsInt, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type, Transform, plainToInstance } from 'class-transformer';
import { VoucherFeeLineDto } from './voucher-fee-line.dto';

export class CreateVoucherDto {
    @IsOptional()
    pdf?: any;

    @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
    @IsInt()
    @IsNotEmpty()
    student_id: number;

    @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
    @IsInt()
    @IsNotEmpty()
    campus_id: number;

    @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
    @IsInt()
    @IsNotEmpty()
    class_id: number;

    @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
    @IsInt()
    @IsOptional()
    section_id?: number;

    @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
    @IsInt()
    @IsNotEmpty()
    bank_account_id: number;

    @IsISO8601()
    @IsNotEmpty()
    issue_date: string;

    @IsISO8601()
    @IsNotEmpty()
    due_date: string;

    @IsISO8601()
    @IsOptional()
    validity_date?: string;

    @Transform(({ value }) => (value === 'true' || value === true))
    @IsBoolean()
    @IsNotEmpty()
    late_fee_charge: boolean;

    @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
    @IsNumber()
    @IsOptional()
    late_fee_amount?: number;

    @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
    @IsInt()
    @IsOptional()
    precedence?: number;

    @Transform(({ value }) => {
        if (value === undefined || value === null) return undefined;
        let arr: any[] = [];
        if (Array.isArray(value)) {
            arr = value;
        } else if (typeof value === 'string') {
            // Handle comma-separated strings or single values
            arr = value.includes(',') ? value.split(',') : [value];
        } else {
            arr = [value];
        }
        return arr
            .map(v => parseInt(String(v).trim(), 10))
            .filter(v => !isNaN(v));
    })
    @IsInt({ each: true })
    @IsOptional()
    orderedFeeIds?: number[];

    @IsString()
    @IsOptional()
    academic_year?: string;

    @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
    @IsInt()
    @IsOptional()
    month?: number;

    /**
     * Specific fee date (ISO 8601). When provided, this is used instead of
     * `month` to identify the fee heads and stamp the voucher — enabling
     * multiple vouchers for the same student in the same calendar month.
     */
    @IsISO8601()
    @IsOptional()
    fee_date?: string;

    /**
     * Fee lines to snapshot into voucher_heads.
     * Each entry captures the price at the moment the voucher is issued,
     * ensuring historical accuracy even if the class fee schedule changes later.
     */
    @Transform(({ value }) => {
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) {
                    return parsed.map(item => plainToInstance(VoucherFeeLineDto, item));
                }
                return parsed;
            } catch (e) {
                return value;
            }
        }
        if (Array.isArray(value)) {
            return value.map(item => plainToInstance(VoucherFeeLineDto, item));
        }
        return value;
    })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => VoucherFeeLineDto)
    @IsOptional()
    fee_lines?: VoucherFeeLineDto[];

    @Transform(({ value }) => (value === 'true' || value === true))
    @IsBoolean()
    @IsOptional()
    waive_surcharge?: boolean;

    @IsString()
    @IsOptional()
    waived_by?: string;

    /** Pre-computed surcharge groups from an outer computeArrears() call. When present,
     *  create() skips its internal computeArrears() call to avoid a redundant DB round-trip. */
    @IsOptional()
    @IsArray()
    pre_computed_surcharge_groups?: Array<{ date: Date; target_month: number; academic_year: string }>;
}
