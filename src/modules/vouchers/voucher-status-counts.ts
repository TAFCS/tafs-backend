/**
 * TAFSD-617: the Vouchers page's count cards, one bucket per voucher status so
 * the cards add up to Total. WAIVED and PARTIALLY_PAID used to fall into
 * `unpaid`; only an UNPAID voucher (or one with no status) counts there now.
 */
export interface VoucherStatusCounts {
    paid: number;
    unpaid: number;
    partially_paid: number;
    overdue: number;
    expired: number;
    waived: number;
    void: number;
}

export function countVoucherStatuses(rows: Array<{ status: string | null }>): VoucherStatusCounts {
    const counts: VoucherStatusCounts = {
        paid: 0,
        unpaid: 0,
        partially_paid: 0,
        overdue: 0,
        expired: 0,
        waived: 0,
        void: 0,
    };
    for (const { status } of rows) {
        switch (status) {
            case 'PAID': counts.paid += 1; break;
            case 'PARTIALLY_PAID': counts.partially_paid += 1; break;
            case 'OVERDUE': counts.overdue += 1; break;
            case 'EXPIRED': counts.expired += 1; break;
            case 'WAIVED': counts.waived += 1; break;
            case 'VOID': counts.void += 1; break;
            default: counts.unpaid += 1;
        }
    }
    return counts;
}
