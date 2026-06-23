import { IsBoolean, IsISO8601, IsNotEmpty, IsOptional } from 'class-validator';

export class SplitPartiallyPaidDto {
    @IsISO8601()
    @IsNotEmpty()
    issue_date!: string;

    @IsISO8601()
    @IsNotEmpty()
    due_date!: string;

    @IsISO8601()
    @IsOptional()
    validity_date?: string;

    // Explicit admin override for the fee_date the new "BALANCE PAYMENT OF" head(s)
    // should carry. If omitted (and use_nearest_future_fee_date is false/unset), the
    // balance head keeps its original fee_date — the default, backwards-compatible
    // behavior.
    @IsISO8601()
    @IsOptional()
    balance_fee_date?: string;

    // When true, the balance head's fee_date is auto-resolved per fee type to the
    // nearest future fee_date already on the student's schedule (the next
    // NOT_ISSUED/ISSUED student_fees row for the same fee_type_id). Takes
    // precedence over balance_fee_date if both are supplied. Typical use case: an
    // arrear deposit where a small late-payment surcharge is settled now and the
    // remaining balance should roll forward onto the next voucher instead of
    // staying on the (already overdue) original period.
    @IsBoolean()
    @IsOptional()
    use_nearest_future_fee_date?: boolean;
}
