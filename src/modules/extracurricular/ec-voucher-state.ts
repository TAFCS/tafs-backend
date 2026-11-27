import type { Prisma } from '@prisma/client';
import { dateKey } from './ec-dates.util';

/**
 * TAFSD-605: the state an extracurricular voucher is shown in. Stored statuses
 * are UNPAID, PARTIALLY_PAID, PAID and WAIVED; EXPIRED and REISSUED are derived
 * here when read, never stored, so no cron is needed and nothing can drift.
 *
 *   PAID / WAIVED            → as stored
 *   has a successor          → REISSUED (history; its charges moved on)
 *   expiry date before today → EXPIRED  (valid through the whole expiry day, PKT)
 *   otherwise                → UNPAID / PARTIALLY_PAID as stored
 */

export const EC_VOUCHER_STATES = ['UNPAID', 'PARTIALLY_PAID', 'PAID', 'WAIVED', 'EXPIRED', 'REISSUED'] as const;
export type EcVoucherState = (typeof EC_VOUCHER_STATES)[number];

export function ecVoucherState(
    v: { status: string; expiry_date: Date | string; reissued_to?: { id: number } | null },
    todayKey: string,
): EcVoucherState {
    if (v.status === 'PAID' || v.status === 'WAIVED') return v.status;
    if (v.reissued_to) return 'REISSUED';
    if (dateKey(v.expiry_date) < todayKey) return 'EXPIRED';
    return v.status === 'PARTIALLY_PAID' ? 'PARTIALLY_PAID' : 'UNPAID';
}

/** True while a voucher can still be paid or changed: open, not reissued, not expired. */
export function ecVoucherIsLive(state: EcVoucherState): boolean {
    return state === 'UNPAID' || state === 'PARTIALLY_PAID';
}

/** True when the voucher still owes money that nobody will collect (expired, not reissued). */
export function ecVoucherIsLapsed(state: EcVoucherState): boolean {
    return state === 'EXPIRED';
}

/** The Prisma filter for "shown in any of these states", with `today` as a DATE (PKT). Empty means all. */
export function ecStateWhere(states: readonly EcVoucherState[], today: Date): Prisma.ec_vouchersWhereInput | undefined {
    if (!states.length) return undefined;
    const open = { in: ['UNPAID', 'PARTIALLY_PAID'] as ('UNPAID' | 'PARTIALLY_PAID')[] };
    const or: Prisma.ec_vouchersWhereInput[] = [];
    for (const s of new Set(states)) {
        switch (s) {
            case 'PAID':
            case 'WAIVED':
                or.push({ status: s });
                break;
            case 'REISSUED':
                or.push({ status: open, reissued_to: { isNot: null } });
                break;
            case 'EXPIRED':
                or.push({ status: open, reissued_to: { is: null }, expiry_date: { lt: today } });
                break;
            case 'UNPAID':
            case 'PARTIALLY_PAID':
                or.push({ status: s, reissued_to: { is: null }, expiry_date: { gte: today } });
                break;
        }
    }
    return { OR: or };
}
