import { IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * A single fee line to be snapshotted into voucher_heads when the voucher is
 * issued. The gross price (amount_before_discount) is read automatically from
 * the linked student_fees record; the caller only needs to supply the discount
 * so the service can derive net_amount = amount_before_discount − discount_amount.
 */
export class VoucherFeeLineDto {
    /** FK → student_fees.id */
    @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
    @IsInt()
    student_fee_id: number;

    /** Discount to apply (0 if none) */
    @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
    @IsNumber({ maxDecimalPlaces: 2 })
    @IsOptional()
    discount_amount?: number;

    /** Label for the discount (e.g. "Sibling") */
    @IsString()
    @IsOptional()
    discount_label?: string;
}
