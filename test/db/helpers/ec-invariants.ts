import type { PrismaClient } from '@prisma/client';

/**
 * TAFSD-605: every money identity of the extracurricular tables, checked from
 * the rows themselves. Returns the list of broken identities (empty = all
 * hold), so a spec can `expect(await ecInvariantProblems(prisma)).toEqual([])`
 * after every step.
 */
export async function ecInvariantProblems(prisma: PrismaClient): Promise<string[]> {
    const problems: string[] = [];
    const n = (v: unknown) => Number(v ?? 0);

    const [vouchers, lines, deposits, allocations, charges] = await Promise.all([
        prisma.ec_vouchers.findMany({ select: { id: true, voucher_number: true, status: true, total_amount: true, amount_paid: true, amount_waived: true, reissued_to: { select: { id: true } } } }),
        prisma.ec_voucher_lines.findMany({ select: { id: true, voucher_id: true, charge_id: true, amount: true, amount_paid: true, waived_amount: true } }),
        prisma.ec_deposits.findMany({ select: { id: true, voucher_id: true, amount: true } }),
        prisma.ec_deposit_allocations.findMany({ select: { deposit_id: true, line_id: true, charge_id: true, amount: true } }),
        prisma.ec_student_charges.findMany({ select: { id: true, amount: true, amount_paid: true, waived_amount: true, status: true, current_voucher_id: true } }),
    ]);

    const sum = <T>(rows: T[], key: (r: T) => number | string, val: (r: T) => number) => {
        const m = new Map<number | string, number>();
        for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
        return m;
    };
    const allocByLine = sum(allocations, (a) => a.line_id, (a) => n(a.amount));
    const allocByCharge = sum(allocations, (a) => a.charge_id, (a) => n(a.amount));
    const allocByDeposit = sum(allocations, (a) => a.deposit_id, (a) => n(a.amount));
    const linesByVoucher = new Map<number, typeof lines>();
    for (const l of lines) linesByVoucher.set(l.voucher_id, [...(linesByVoucher.get(l.voucher_id) ?? []), l]);
    const depositsByVoucher = sum(deposits, (d) => d.voucher_id, (d) => n(d.amount));
    const waivedByCharge = sum(lines, (l) => l.charge_id, (l) => n(l.waived_amount));
    const voucherById = new Map(vouchers.map((v) => [v.id, v]));

    // 1. Lines.
    for (const l of lines) {
        if (n(l.amount_paid) !== (allocByLine.get(l.id) ?? 0)) problems.push(`line ${l.id}: paid ${n(l.amount_paid)} ≠ allocations ${allocByLine.get(l.id) ?? 0}`);
        if (n(l.amount_paid) + n(l.waived_amount) > n(l.amount)) problems.push(`line ${l.id}: paid + waived > amount`);
        if (n(l.amount) <= 0) problems.push(`line ${l.id}: amount ≤ 0`);
    }

    // 2. Vouchers.
    for (const v of vouchers) {
        const ls = linesByVoucher.get(v.id) ?? [];
        const total = ls.reduce((s, l) => s + n(l.amount), 0);
        const paid = ls.reduce((s, l) => s + n(l.amount_paid), 0);
        const waived = ls.reduce((s, l) => s + n(l.waived_amount), 0);
        if (n(v.total_amount) !== total) problems.push(`voucher ${v.voucher_number}: total ${n(v.total_amount)} ≠ lines ${total}`);
        if (n(v.amount_paid) !== paid) problems.push(`voucher ${v.voucher_number}: paid ${n(v.amount_paid)} ≠ lines ${paid}`);
        if (n(v.amount_paid) !== (depositsByVoucher.get(v.id) ?? 0)) problems.push(`voucher ${v.voucher_number}: paid ≠ its deposits`);
        if (n(v.amount_waived) !== waived) problems.push(`voucher ${v.voucher_number}: waived ≠ lines`);
        const balance = total - paid - waived;
        const expected = balance > 0 ? (paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID') : waived > 0 ? 'WAIVED' : 'PAID';
        if (v.status !== expected) problems.push(`voucher ${v.voucher_number}: status ${v.status}, money says ${expected}`);
        if (!/^EC\d{10,}$/.test(v.voucher_number ?? '')) problems.push(`voucher ${v.id}: number ${v.voucher_number}`);
    }

    // 3. Deposits.
    for (const d of deposits) {
        if (n(d.amount) <= 0) problems.push(`deposit ${d.id}: amount ≤ 0`);
        if (n(d.amount) !== (allocByDeposit.get(d.id) ?? 0)) problems.push(`deposit ${d.id}: amount ≠ its allocations`);
    }

    // 4. Charges.
    for (const c of charges) {
        const paid = allocByCharge.get(c.id) ?? 0;
        const waived = waivedByCharge.get(c.id) ?? 0;
        if (n(c.amount_paid) !== paid) problems.push(`charge ${c.id}: paid ${n(c.amount_paid)} ≠ allocations ${paid}`);
        if (n(c.waived_amount) !== waived) problems.push(`charge ${c.id}: waived ≠ its lines`);
        const rest = n(c.amount) - paid - waived;
        const expected = c.current_voucher_id == null ? 'NOT_ISSUED' : rest <= 0 ? (waived > 0 ? 'WAIVED' : 'PAID') : paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED';
        if (c.status !== expected) problems.push(`charge ${c.id}: status ${c.status}, money says ${expected}`);
        if (c.current_voucher_id != null) {
            const cv = voucherById.get(c.current_voucher_id);
            if (!cv) problems.push(`charge ${c.id}: current voucher missing`);
            else {
                if (cv.reissued_to) problems.push(`charge ${c.id}: still on reissued voucher ${cv.voucher_number}`);
                if (!(linesByVoucher.get(cv.id) ?? []).some((l) => l.charge_id === c.id)) problems.push(`charge ${c.id}: its voucher has no line for it`);
            }
        }
    }

    // 5. Everything received equals everything credited to charges.
    const totalDeposits = deposits.reduce((s, d) => s + n(d.amount), 0);
    const totalChargePaid = charges.reduce((s, c) => s + n(c.amount_paid), 0);
    if (totalDeposits !== totalChargePaid) problems.push(`Σ deposits ${totalDeposits} ≠ Σ charges paid ${totalChargePaid}`);

    return problems;
}
