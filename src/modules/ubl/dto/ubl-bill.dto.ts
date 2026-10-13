import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

/**
 * Collection channel the request came through. Mandatory on every call:
 * ONEBILL inquiries are quoted +30 PKR (1Bill's aggregator fee) and payments
 * are reconciled per channel. See docs/ubl-api (TAFSD-294).
 */
export const UBL_CHANNELS = ['ONEBILL', 'OTC', 'APP', 'INTERNET_BANKING'] as const;
export type UblChannel = (typeof UBL_CHANNELS)[number];

/** How the payer actually paid. Mandatory on every payment. */
export const UBL_PAYMENT_METHODS = [
    'CASH',
    'CHEQUE',
    'PAY_ORDER',
    'ACCOUNT_TRANSFER',
    'DEBIT_CARD',
    'CREDIT_CARD',
    'WALLET',
    'OTHER',
] as const;
export type UblPaymentMethod = (typeof UBL_PAYMENT_METHODS)[number];

export class UblBillInquiryQueryDto {
    /** A student's CC, or a 1Bill consumer number ([10-digit prefix][4-digit CC]). */
    @IsString()
    @IsNotEmpty()
    @Matches(/^\d{1,20}$/, { message: 'consumer_number must be digits only' })
    consumer_number!: string;

    @IsIn(UBL_CHANNELS as unknown as string[])
    channel!: UblChannel;
}

export class UblBillPaymentDto {
    @IsString()
    @IsNotEmpty()
    @Matches(/^\d{1,20}$/, { message: 'consumer_number must be digits only' })
    consumer_number!: string;

    @IsIn(UBL_CHANNELS as unknown as string[])
    channel!: UblChannel;

    @IsIn(UBL_PAYMENT_METHODS as unknown as string[])
    payment_method!: UblPaymentMethod;

    /** Amount the payer paid, in PKR. For ONEBILL this includes the 30 PKR fee. */
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0.01)
    amount!: number;

    /** UBL's unique transaction id. Re-sending the same id never books twice. */
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    transaction_id!: string;

    /** When the payment was taken, ISO 8601 with offset (e.g. 2026-10-12T10:15:00+05:00). */
    @IsISO8601()
    transaction_datetime!: string;

    /** Voucher number returned by the inquiry. If sent, it must still be the student's latest voucher. */
    @IsOptional()
    @IsString()
    @MaxLength(20)
    voucher_number?: string;

    /** UBL branch code — OTC payments. */
    @IsOptional()
    @IsString()
    @MaxLength(20)
    branch_code?: string;

    /** Paying bank — 1Bill payments made from another bank. */
    @IsOptional()
    @IsString()
    @MaxLength(20)
    payer_bank_code?: string;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    payer_bank_name?: string;

    /** Required when payment_method is CHEQUE or PAY_ORDER. */
    @IsOptional()
    @IsString()
    @MaxLength(30)
    instrument_number?: string;
}
