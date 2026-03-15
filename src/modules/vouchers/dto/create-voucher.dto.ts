import { IsArray, IsBoolean, IsInt, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type, Transform } from 'class-transformer';

/**
 * A single fee line to be snapshotted into voucher_heads when the voucher is
 * issued. The gross price (amount_before_discount) is read automatically from
 * the linked student_fees record; the caller only needs to supply the discount
 * so the service can derive net_amount = amount_before_discount − discount_amount.
 */
export class VoucherFeeLineDto {
    /** FK → student_fees.id */
    @IsInt()
    student_fee_id: number;

    /** Discount to apply (0 if none) */
    @IsNumber({ maxDecimalPlaces: 2 })
    @IsOptional()
    discount_amount?: number;
}

export class CreateVoucherDto {
    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    student_id: number;

    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    campus_id: number;

    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    class_id: number;

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    section_id?: number;

    @Type(() => Number)
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

    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    @IsNotEmpty()
    late_fee_charge: boolean;

    @Type(() => Number)
    @IsNumber()
    @IsOptional()
    late_fee_amount?: number;

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    precedence?: number;

    @Type(() => Number)
    @IsInt({ each: true })
    @IsOptional()
    orderedFeeIds?: number[];

    @IsString()
    @IsOptional()
    academic_year?: string;

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    month?: number;

    /**
     * Fee lines to snapshot into voucher_heads.
     * Each entry captures the price at the moment the voucher is issued,
     * ensuring historical accuracy even if the class fee schedule changes later.
     */
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => VoucherFeeLineDto)
    @IsOptional()
    fee_lines?: VoucherFeeLineDto[];
}
