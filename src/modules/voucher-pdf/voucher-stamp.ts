/**
 * The diagonal stamp printed across an unpaid challan (TAFSD-419, TAFSD-420).
 *
 * One stamp for the page, built from flags frozen on the voucher row, so every
 * render path and every reprint agrees. Lines print in this order: PAY
 * IMMEDIATELY, the final-notice warning, REVISED. A PAID receipt or WAIVED
 * challan carries its own stamp instead: prepareVoucherPdfData() turns these
 * flags off for those renders.
 */
export const PAY_IMMEDIATELY_TEXT = 'PAY IMMEDIATELY';
export const FINAL_NOTICE_TEXT = 'FINAL NOTICE: SERVICES MAY BE SUSPENDED';
export const REVISED_TEXT = 'REVISED';

const RED = '#dc2626';
const INDIGO = '#4338ca';

export interface VoucherStampLine {
    text: string;
    fontSize: number;
    letterSpacing: number;
    color: string;
    opacity: number;
}

export function voucherStampLines(flags: {
    payImmediate?: boolean;
    payImmediateRepeat?: boolean;
    revised?: boolean;
}): VoucherStampLine[] {
    const lines: VoucherStampLine[] = [];
    if (flags.payImmediate) {
        lines.push({ text: PAY_IMMEDIATELY_TEXT, fontSize: 80, letterSpacing: 6, color: RED, opacity: 0.16 });
        // The warning only ever escalates a PAY IMMEDIATELY voucher.
        if (flags.payImmediateRepeat) {
            // Darker than the rest: it is the small print a parent must not miss.
            lines.push({ text: FINAL_NOTICE_TEXT, fontSize: 32, letterSpacing: 1.5, color: RED, opacity: 0.34 });
        }
    }
    if (flags.revised) {
        // Under PAY IMMEDIATELY it is the secondary message; alone it fills the page.
        lines.push(
            lines.length > 0
                ? { text: REVISED_TEXT, fontSize: 56, letterSpacing: 8, color: INDIGO, opacity: 0.16 }
                : { text: REVISED_TEXT, fontSize: 110, letterSpacing: 14, color: INDIGO, opacity: 0.16 },
        );
    }
    return lines;
}
