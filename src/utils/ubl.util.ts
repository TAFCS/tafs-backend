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
 * 1Bill charge by transaction slab, borne by the payer and never booked as fees
 * (TAFSD-294): 1LINK's Same Day Settlement Service Fee + its Direct Biller /
 * Bill Aggregator charge, the sum rounded up to whole rupees.
 *   Up to 5K      4 + 12.50 = 16.50 → 17
 *   5K–10K        5 + 15.50 = 20.50 → 21
 *   10K–100K     14 + 39    = 53
 *   100K–250K    22 + 62.50 = 84.50 → 85
 *   250K–1M      44 + 125   = 169
 *   1M–2.5M      88 + 250   = 338
 *   2.5M–5M     131 + 375   = 506
 *   above 5M    175 + 500   = 675
 */
export const UBL_1BILL_CHARGE_SLABS: ReadonlyArray<{ upTo: number; charge: number }> = [
    { upTo: 5_000, charge: 17 },
    { upTo: 10_000, charge: 21 },
    { upTo: 100_000, charge: 53 },
    { upTo: 250_000, charge: 85 },
    { upTo: 1_000_000, charge: 169 },
    { upTo: 2_500_000, charge: 338 },
    { upTo: 5_000_000, charge: 506 },
    { upTo: Number.POSITIVE_INFINITY, charge: 675 },
];

function slabCharge(transactionAmount: number): number {
    return UBL_1BILL_CHARGE_SLABS.find((s) => transactionAmount <= s.upTo)!.charge;
}

/**
 * The 1Bill charge on a bill. The slab is that of the transaction 1LINK sees —
 * bill + charge — so when the charge pushes the total past a slab boundary the
 * next slab's charge applies (99,980 + 53 > 100,000 → 85).
 */
export function ubl1BillCharge(billAmount: number): number {
    const first = slabCharge(billAmount);
    return slabCharge(billAmount + first);
}

/** True when UBL sent a 15-digit 1Bill consumer number rather than a bare CC. */
export function isUbl1BillConsumerNumber(consumerNumber: string): boolean {
    const raw = (consumerNumber ?? '').trim();
    const prefix = ubl1BillPrefix();
    return raw.length === prefix.length + UBL_CC_DIGITS && raw.startsWith(prefix);
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
