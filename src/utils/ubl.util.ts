import { toMeezanVoucherNumber } from './meezan.util';

/**
 * Placeholder 1Bill biller prefix until UBL issues the real one (TAFSD-294).
 * Override with UBL_1BILL_PREFIX once known — it must be exactly 10 digits.
 */
export const UBL_1BILL_PREFIX_PLACEHOLDER = '1000000000';

/**
 * Width every CC is written in for UBL: zero-padded to 5 digits (8088 → 08088),
 * so 1Bill numbers stay a fixed 15 digits once CCs reach 10000.
 */
export const UBL_CC_DIGITS = 5;

/**
 * Assumed 1Bill aggregator charge, borne by the payer and never booked as fees.
 * Not yet confirmed by UBL — set UBL_1BILL_CHANNEL_FEE once they do.
 */
export const UBL_1BILL_CHANNEL_FEE_DEFAULT = 30;

export function ubl1BillChannelFee(): number {
    const raw = (process.env.UBL_1BILL_CHANNEL_FEE ?? '').trim();
    const configured = Number(raw);
    return raw !== '' && Number.isFinite(configured) && configured >= 0 ? configured : UBL_1BILL_CHANNEL_FEE_DEFAULT;
}

/** CC as printed on UBL vouchers and used in 1Bill numbers: 5 digits, zero-padded. */
export function ublCc(cc: number | string): string {
    return String(cc).padStart(UBL_CC_DIGITS, '0');
}

/** True when a bank_accounts.bank_name names UBL ("UBL", "United Bank Limited", …). */
export function isUblBank(bankName?: string | null): boolean {
    const n = (bankName ?? '').toLowerCase();
    return /\bubl\b/.test(n) || n.includes('united bank');
}

/**
 * The number stored in vouchers.voucher_number and printed on the challan.
 * UBL vouchers carry the plain serial (the voucher id) — UBL looks bills up by
 * CC, not by voucher number. Everything else keeps the Meezan MMYY+id format,
 * which MeezanService resolves vouchers by.
 */
export function voucherNumberFor(voucherId: number, date: Date, bankName?: string | null): string {
    return isUblBank(bankName) ? String(voucherId) : toMeezanVoucherNumber(voucherId, date);
}

export function ubl1BillPrefix(): string {
    const configured = (process.env.UBL_1BILL_PREFIX ?? '').trim();
    return /^\d{10}$/.test(configured) ? configured : UBL_1BILL_PREFIX_PLACEHOLDER;
}

/** 1Bill consumer number for a student: [10-digit prefix][CC zero-padded to 5] = 15 digits. */
export function ubl1BillConsumerNumber(cc: number | string): string {
    return `${ubl1BillPrefix()}${ublCc(cc)}`;
}

/**
 * Resolve the CC from what UBL sends as the consumer number: either a 1Bill
 * consumer number (prefix + 5-digit CC) or a bare CC of up to 5 digits,
 * leading zeros optional (08088 and 8088 are the same student). Returns null if neither.
 */
export function ccFromUblConsumerNumber(consumerNumber: string): number | null {
    const raw = (consumerNumber ?? '').trim();
    if (!/^\d+$/.test(raw)) return null;
    const prefix = ubl1BillPrefix();
    if (raw.length === prefix.length + UBL_CC_DIGITS && raw.startsWith(prefix)) {
        const cc = parseInt(raw.slice(prefix.length), 10);
        return cc > 0 ? cc : null;
    }
    if (raw.length <= UBL_CC_DIGITS) {
        const cc = parseInt(raw, 10);
        return cc > 0 ? cc : null;
    }
    return null;
}
