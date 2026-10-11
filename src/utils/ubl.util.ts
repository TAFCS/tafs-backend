import { toMeezanVoucherNumber } from './meezan.util';

/**
 * Placeholder 1Bill biller prefix until UBL issues the real one (TAFSD-294).
 * Override with UBL_1BILL_PREFIX once known — it must be exactly 10 digits.
 */
export const UBL_1BILL_PREFIX_PLACEHOLDER = '1000000000';

/** Width of the CC part of a 1Bill consumer number: [10-digit prefix][CC as 4 digits]. */
export const UBL_1BILL_CC_DIGITS = 4;

/** Aggregator fee 1Bill adds on top of the payable amount (kept by 1Bill, never booked as fees). */
export const UBL_1BILL_CHANNEL_FEE = 30;

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

/** 1Bill consumer number for a student: [10-digit prefix][CC zero-padded to 4]. */
export function ubl1BillConsumerNumber(cc: number | string): string {
    return `${ubl1BillPrefix()}${String(cc).padStart(UBL_1BILL_CC_DIGITS, '0')}`;
}

/**
 * Resolve the CC from what UBL sends as the consumer number: either a 1Bill
 * consumer number (prefix + 4-digit CC) or a bare CC. Returns null if neither.
 */
export function ccFromUblConsumerNumber(consumerNumber: string): number | null {
    const raw = (consumerNumber ?? '').trim();
    if (!/^\d+$/.test(raw)) return null;
    const prefix = ubl1BillPrefix();
    if (raw.length === prefix.length + UBL_1BILL_CC_DIGITS && raw.startsWith(prefix)) {
        const cc = parseInt(raw.slice(prefix.length), 10);
        return cc > 0 ? cc : null;
    }
    if (raw.length <= UBL_1BILL_CC_DIGITS) {
        const cc = parseInt(raw, 10);
        return cc > 0 ? cc : null;
    }
    return null;
}
