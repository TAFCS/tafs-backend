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

    /**
     * Discount to apply (0 if none). Rounded to 2dp on the way in — callers derive
     * this as `amount_before_discount − amount`, a float subtraction that routinely
     * leaves sub-cent noise (e.g. 16975.00 − 5658.33 = 11316.669999999998) which
     * would otherwise fail the maxDecimalPlaces check. A non-numeric value stays
     * NaN so @IsNumber still rejects it.
     */
    @Transform(({ value }) => {
        if (value === undefined || value === null || value === '') return undefined;
        const n = Number(value);
        return Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
    })
    @IsNumber({ maxDecimalPlaces: 2 })
    @IsOptional()
    discount_amount?: number;

    /** Label for the discount (e.g. "Sibling") */
    @IsString()
    @IsOptional()
    discount_label?: string;
}
