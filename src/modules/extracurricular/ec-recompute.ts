import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { deriveChargeStatus, deriveVoucherStatus } from './ec-money.util';

/**
 * TAFSD-605: THE place extracurricular money totals are written. Every change
 * (issue, deposit, reversal, reissue, waive, unwaive, delete) ends by calling
 * this, which re-derives everything from the allocations and line waivers that
 * exist now. Nothing anywhere adds to or subtracts from a paid total by hand.
 *
 *   line.amount_paid    = Σ its allocations
 *   charge.amount_paid  = Σ the charge's allocations on every voucher (reissue chains)
 *   charge.waived_amount= Σ the charge's line waivers on every voucher
 *   voucher totals      = Σ over its lines; status from the money
 *
 * Throws (rolling the transaction back) if a line would be over-paid: the
 * service-layer stand-in for a CHECK constraint.
 *
 * Returns the stamped receipt URL the voucher just lost, if it left PAID, so the
 * caller can delete the file after commit.
 */
export async function recomputeVoucherInTx(
    tx: Prisma.TransactionClient,
    voucherId: number,
): Promise<{ status: string; clearedPaidPdfUrl: string | null }> {
    const voucher = await tx.ec_vouchers.findUniqueOrThrow({
        where: { id: voucherId },
        select: { id: true, status: true, paid_pdf_url: true },
    });
    const lines = await tx.ec_voucher_lines.findMany({
        where: { voucher_id: voucherId },
        select: { id: true, charge_id: true, amount: true, amount_paid: true, waived_amount: true },
    });

    const lineSums = lines.length
        ? await tx.ec_deposit_allocations.groupBy({ by: ['line_id'], where: { line_id: { in: lines.map((l) => l.id) } }, _sum: { amount: true } })
        : [];
    const paidByLine = new Map(lineSums.map((s) => [s.line_id, Number(s._sum.amount ?? 0)]));

    let total = 0;
    let paid = 0;
    let waived = 0;
    for (const l of lines) {
        const amount = Number(l.amount);
        const linePaid = paidByLine.get(l.id) ?? 0;
        const lineWaived = Number(l.waived_amount);
        if (linePaid + lineWaived > amount) {
            throw new ConflictException('That would pay more than the voucher line owes');
        }
        if (linePaid !== Number(l.amount_paid)) {
            await tx.ec_voucher_lines.update({ where: { id: l.id }, data: { amount_paid: linePaid } });
        }
        total += amount;
        paid += linePaid;
        waived += lineWaived;
    }

    const chargeIds = [...new Set(lines.map((l) => l.charge_id))];
    if (chargeIds.length) {
        const [charges, chargePaid, chargeWaived] = await Promise.all([
            tx.ec_student_charges.findMany({ where: { id: { in: chargeIds } }, select: { id: true, amount: true, current_voucher_id: true } }),
            tx.ec_deposit_allocations.groupBy({ by: ['charge_id'], where: { charge_id: { in: chargeIds } }, _sum: { amount: true } }),
            tx.ec_voucher_lines.groupBy({ by: ['charge_id'], where: { charge_id: { in: chargeIds } }, _sum: { waived_amount: true } }),
        ]);
        const paidOf = new Map(chargePaid.map((s) => [s.charge_id, Number(s._sum.amount ?? 0)]));
        const waivedOf = new Map(chargeWaived.map((s) => [s.charge_id, Number(s._sum.waived_amount ?? 0)]));
        for (const c of charges) {
            const amount = Number(c.amount);
            const amount_paid = paidOf.get(c.id) ?? 0;
            const waived_amount = waivedOf.get(c.id) ?? 0;
            if (amount_paid + waived_amount > amount) throw new ConflictException('That would pay more than the charge');
            await tx.ec_student_charges.update({
                where: { id: c.id },
                data: {
                    amount_paid,
                    waived_amount,
                    status: deriveChargeStatus({ amount, amount_paid, waived_amount, on_voucher: c.current_voucher_id != null }),
                },
            });
        }
    }

    const status = deriveVoucherStatus({ total, paid, waived });
    const leftPaid = voucher.status === 'PAID' && status !== 'PAID';
    await tx.ec_vouchers.update({
        where: { id: voucherId },
        data: {
            total_amount: total,
            amount_paid: paid,
            amount_waived: waived,
            status,
            ...(leftPaid ? { paid_pdf_url: null, paid_pdf_filename: null, paid_pdf_generated_at: null } : {}),
        },
    });
    return { status, clearedPaidPdfUrl: leftPaid ? voucher.paid_pdf_url : null };
}

/** Serialise every money change on one voucher (Postgres row lock until the transaction ends). */
export async function lockEcVoucher(tx: Prisma.TransactionClient, voucherId: number): Promise<void> {
    await tx.$queryRaw`SELECT id FROM ec_vouchers WHERE id = ${voucherId} FOR UPDATE`;
}
