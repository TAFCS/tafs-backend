import { Transform, Type } from 'class-transformer';
import { IsIn, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

/**
 * Collection channel a payment came through, for reconciliation. Whether the
 * 1Bill charge applies is decided by the consumer number (15 digits = 1Bill),
 * not by this. See docs/ubl-api (TAFSD-294).
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

/**
 * A 1Bill payment's payment_method is ONEBILL (agreed with UBL, 18 Nov 2026);
 * an empty one on a 1Bill payment means the same. CC payments send one of
 * UBL_PAYMENT_METHODS.
 */
export const UBL_ONEBILL_METHOD = 'ONEBILL' as const;
export const UBL_ALL_PAYMENT_METHODS = [...UBL_PAYMENT_METHODS, UBL_ONEBILL_METHOD] as const;
export type UblAnyPaymentMethod = (typeof UBL_ALL_PAYMENT_METHODS)[number];

/** UBL's middleware sends "{}" (and sometimes "" or "null") for a field it has no value for. */
export function ublBlankToUndefined(value: unknown): unknown {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'string') return value;
    const v = value.trim();
    if (v === '' || v === '{}' || v.toLowerCase() === 'null') return undefined;
    return v;
}
const Blank = () => Transform(({ value }) => ublBlankToUndefined(value));

/**
 * transaction_datetime as UBL sends it. ISO 8601 passes through; the compact
 * forms YYYYMMDD and YYYYMMDDHHmm[ss] are Pakistan time (a bare date is the
 * start of that day). Anything else is left as is and fails validation.
 */
export function normalizeUblDatetime(value: unknown): unknown {
    const v = ublBlankToUndefined(value);
    if (typeof v !== 'string') return v;
    const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/.exec(v);
    if (!m) return v;
    const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
    return `${y}-${mo}-${d}T${h}:${mi}:${se}+05:00`;
}

export class UblBillInquiryQueryDto {
    /** A student's CC (normal amount), or a 15-digit 1Bill consumer number ([10-digit prefix][5-digit CC]) (1Bill amount). */
    @IsString()
    @IsNotEmpty()
    @Matches(/^\d{1,20}$/, { message: 'consumer_number must be digits only' })
    consumer_number!: string;

    /** No longer used — the consumer number decides the amount. Accepted so older callers aren't rejected. */
    @IsOptional()
    @IsIn(UBL_CHANNELS as unknown as string[])
    channel?: UblChannel;
}

export class UblBillPaymentDto {
    @IsString()
    @IsNotEmpty()
    @Matches(/^\d{1,20}$/, { message: 'consumer_number must be digits only' })
    consumer_number!: string;

    /** Required for a CC (OTC, APP or INTERNET_BANKING); optional for a 1Bill number, which is always ONEBILL. */
    @Blank()
    @IsOptional()
    @IsIn(UBL_CHANNELS as unknown as string[])
    channel?: UblChannel;

    /**
     * 1Bill consumer number: ONEBILL, or empty (treated as ONEBILL).
     * CC: one of UBL_PAYMENT_METHODS — required; checked in the service.
     */
    @Blank()
    @IsOptional()
    @IsIn(UBL_ALL_PAYMENT_METHODS as unknown as string[])
    payment_method?: UblAnyPaymentMethod;

    /** Amount the payer paid, in PKR. For a 1Bill number this includes the 1Bill charge. */
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0.01)
    amount!: number;

    /** UBL's unique transaction id. Re-sending the same id never books twice. */
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    transaction_id!: string;

    /**
     * When the payment was taken: ISO 8601 with offset (e.g. 2026-10-12T10:15:00+05:00),
     * or YYYYMMDD / YYYYMMDDHHmmss in Pakistan time.
     */
    @Transform(({ value }) => normalizeUblDatetime(value))
    @IsISO8601({ strict: true }, { message: 'transaction_datetime must be ISO 8601, YYYYMMDD or YYYYMMDDHHmmss' })
    transaction_datetime!: string;

    /** Voucher number returned by the inquiry. If sent, it must still be the student's latest voucher. */
    @Blank()
    @IsOptional()
    @IsString()
    @MaxLength(20)
    voucher_number?: string;

    /** UBL branch code — OTC payments. */
    @Blank()
    @IsOptional()
    @IsString()
    @MaxLength(20)
    branch_code?: string;

    /** Paying bank — 1Bill payments made from another bank. */
    @Blank()
    @IsOptional()
    @IsString()
    @MaxLength(20)
    payer_bank_code?: string;

    @Blank()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    payer_bank_name?: string;

    /** Required when payment_method is CHEQUE or PAY_ORDER. */
    @Blank()
    @IsOptional()
    @IsString()
    @MaxLength(30)
    instrument_number?: string;
}
