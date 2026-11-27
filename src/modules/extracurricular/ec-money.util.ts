import { BadRequestException } from '@nestjs/common';
import type { ec_charge_status, ec_voucher_status } from '@prisma/client';

/**
 * TAFSD-605: the money rules of extracurricular vouchers, as pure functions so
 * every path (issue, deposit, reversal, reissue, waive) shares them and they are
 * unit-tested on their own. Amounts are whole rupees.
 */

/** "EC" + MMYY of the issue date + the id padded to 6 digits (longer ids are never cut). */
export function formatEcVoucherNumber(id: number, issueDate: Date): string {
    const mm = String(issueDate.getUTCMonth() + 1).padStart(2, '0');
    const yy = String(issueDate.getUTCFullYear()).slice(-2);
    return `EC${mm}${yy}${String(id).padStart(6, '0')}`;
}

/** What a line (or a charge) still owes. Never negative. */
export function remainingOf(x: { amount: number; amount_paid: number; waived_amount: number }): number {
    return Math.max(x.amount - x.amount_paid - x.waived_amount, 0);
}

export type AllocationLine = { id: number; remaining: number };

/**
 * Pour `amount` into the lines in the order given, each up to its remaining.
 * Refuses a zero, fractional or negative amount, and more than the lines owe.
 */
export function allocateAuto(lines: AllocationLine[], amount: number): Map<number, number> {
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('The amount must be a whole number of rupees above 0');
    const owed = lines.reduce((n, l) => n + l.remaining, 0);
    if (amount > owed) throw new BadRequestException(`The amount (Rs ${amount}) is more than the voucher's balance (Rs ${owed})`);
    const out = new Map<number, number>();
    let left = amount;
    for (const l of lines) {
        if (left <= 0) break;
        const take = Math.min(left, l.remaining);
        if (take > 0) {
            out.set(l.id, take);
            left -= take;
        }
    }
    return out;
}

/**
 * Check a split chosen by hand: every line belongs to the voucher, each part is
 * a whole number above 0 and at most that line's remaining, and the parts add
 * up to the amount.
 */
export function validateManual(lines: AllocationLine[], parts: { line_id: number; amount: number }[], amount: number): Map<number, number> {
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('The amount must be a whole number of rupees above 0');
    const byId = new Map(lines.map((l) => [l.id, l]));
    const out = new Map<number, number>();
    for (const p of parts) {
        if (p.amount === 0) continue;
        const line = byId.get(p.line_id);
        if (!line) throw new BadRequestException(`Line #${p.line_id} is not on this voucher`);
        if (!Number.isInteger(p.amount) || p.amount < 0) throw new BadRequestException('Each part must be a whole number of rupees');
        if (out.has(p.line_id)) throw new BadRequestException(`Line #${p.line_id} appears twice`);
        if (p.amount > line.remaining) throw new BadRequestException(`Rs ${p.amount} is more than that line still owes (Rs ${line.remaining})`);
        out.set(p.line_id, p.amount);
    }
    const sum = [...out.values()].reduce((n, v) => n + v, 0);
    if (sum !== amount) throw new BadRequestException(`The parts add up to Rs ${sum}, not Rs ${amount}`);
    return out;
}

/** A charge's status from its money and whether a voucher bills it. */
export function deriveChargeStatus(c: { amount: number; amount_paid: number; waived_amount: number; on_voucher: boolean }): ec_charge_status {
    if (!c.on_voucher) return 'NOT_ISSUED';
    if (remainingOf(c) <= 0) return c.waived_amount > 0 ? 'WAIVED' : 'PAID';
    return c.amount_paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED';
}

/** A voucher's stored status from its money. EXPIRED / REISSUED are derived when read, never stored. */
export function deriveVoucherStatus(v: { total: number; paid: number; waived: number }): ec_voucher_status {
    const balance = v.total - v.paid - v.waived;
    if (balance > 0) return v.paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
    return v.waived > 0 ? 'WAIVED' : 'PAID';
}
