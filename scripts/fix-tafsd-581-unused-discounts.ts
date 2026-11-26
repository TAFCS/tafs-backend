/**
 * TAFSD-581 data fix: vouchers paid at full value while their discount was left unused.
 *
 * Twelve PAID vouchers, CC 7165's #14176 among them, carry a "full year advance
 * payment" discount that was never used: they were paid after their validity
 * date, the deposit page asked for the gross amount (the EXPIRED-voucher bug
 * fixed in TAFSD-581), and the gross was recorded. Which correction applies
 * depends on what finance finds in the bank record for each one:
 *
 *   A. The family paid the challan amount. The recorded deposit overstates
 *      cash by the discount. Fix it in the app, not here: on the deposit page,
 *      clear the deposit (it is the student's latest), then record the real
 *      amount. With the TAFSD-581 fix live the page asks for the discounted
 *      total and the discount is spent.
 *
 *   B. The family paid the full amount because the discount was forfeited for
 *      paying late. The discount row should go. --apply does this: it removes
 *      the discount head and the discount student_fees row, sets the voucher's
 *      totals to the full fees, and unlinks the frozen PAID receipt (it prints
 *      the discount) so the next download re-renders it. The file in storage is
 *      kept. The deposit and the fee heads are not touched: they already say
 *      the full amount was paid.
 *
 * Earlier the plan was to re-date CC 7165's months to their own fee dates and
 * regenerate #14176. That no longer applies: #14176 is PAID (deposit #7135,
 * 24 Nov), and the fee schedule's audit log shows the year was put on 1 Nov on
 * purpose (23 Oct, with the advance discount).
 *
 * Usage:
 *   npx ts-node -r dotenv/config scripts/fix-tafsd-581-unused-discounts.ts                 # dry run, every voucher
 *   npx ts-node -r dotenv/config scripts/fix-tafsd-581-unused-discounts.ts --voucher 14176 # dry run, one voucher
 *   TAFSD581_APPLY=finance-said-forfeited npx ts-node -r dotenv/config \
 *     scripts/fix-tafsd-581-unused-discounts.ts --voucher 14176 --apply                     # option B, one voucher
 *
 * --apply needs --voucher (one at a time, after finance confirms option B for
 * that voucher) and the env var. Nothing runs without both.
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const vIdx = args.indexOf('--voucher');
const ONLY = vIdx >= 0 ? Number(args[vIdx + 1]) : null;
const rs = (v: Prisma.Decimal.Value) => `Rs ${Number(new Prisma.Decimal(v).toFixed(0)).toLocaleString('en-US')}`;

async function main() {
  if (APPLY && (ONLY == null || process.env.TAFSD581_APPLY !== 'finance-said-forfeited')) {
    throw new Error('--apply needs --voucher <id> and TAFSD581_APPLY=finance-said-forfeited.');
  }

  const rows = await prisma.$queryRaw<any[]>`
    SELECT v.id, v.student_id, v.status, v.fee_date, v.validity_date,
           v.total_payable_before_due, v.total_payable_after_due, v.late_fee_deposited,
           vh.id AS discount_head_id, sf.id AS discount_fee_id, sf.amount AS discount, sf.amount_paid AS discount_used,
           (SELECT COALESCE(SUM(h.net_amount), 0) FROM voucher_heads h JOIN student_fees f ON f.id = h.student_fee_id
             WHERE h.voucher_id = v.id AND NOT f.is_discount AND NOT h.waived) AS fees,
           (SELECT COALESCE(SUM(x.total_amount), 0) FROM deposits x
             WHERE x.id IN (SELECT a.deposit_id FROM deposit_allocations a WHERE a.voucher_id = v.id)) AS recorded,
           (SELECT COUNT(*)::int FROM voucher_heads h2 WHERE h2.student_fee_id = sf.id) AS discount_on_vouchers
      FROM vouchers v
      JOIN voucher_heads vh ON vh.voucher_id = v.id
      JOIN student_fees sf ON sf.id = vh.student_fee_id AND sf.is_discount
     WHERE v.status = 'PAID' AND sf.amount_paid = 0
       AND (${ONLY}::int IS NULL OR v.id = ${ONLY}::int)
     ORDER BY v.id`;

  if (!rows.length) {
    console.log(ONLY ? `Voucher #${ONLY}: no PAID voucher with an unused discount.` : 'Nothing to fix.');
    return;
  }

  for (const r of rows) {
    const fees = new Prisma.Decimal(r.fees);
    const lateFee = new Prisma.Decimal(r.total_payable_after_due).sub(r.total_payable_before_due);
    const challanAfter = new Prisma.Decimal(r.total_payable_after_due);
    const recorded = new Prisma.Decimal(r.recorded);
    console.log(
      `\nVoucher #${r.id} (CC ${r.student_id}), fee date ${new Date(r.fee_date).toISOString().slice(0, 10)}` +
        `\n  challan: fees ${rs(fees)} − discount ${rs(r.discount)} = ${rs(r.total_payable_before_due)}; after due ${rs(challanAfter)}` +
        `\n  recorded deposits: ${rs(recorded)} (${rs(recorded.sub(challanAfter))} over the challan)` +
        `\n  A (paid the challan): clear the deposit in the app and record ${rs(challanAfter)}.` +
        `\n  B (discount forfeited): remove discount row #${r.discount_fee_id} (head #${r.discount_head_id}); totals → ${rs(fees)} / ${rs(fees.add(lateFee))}; unlink the PAID receipt.`,
    );
    if (r.discount_on_vouchers !== 1) {
      console.log(`  ! discount row #${r.discount_fee_id} sits on ${r.discount_on_vouchers} vouchers: not handled here, check by hand.`);
      continue;
    }

    if (!APPLY) continue;
    await prisma.$transaction(async (tx) => {
      const sf = await tx.student_fees.findUniqueOrThrow({ where: { id: r.discount_fee_id } });
      if (!sf.is_discount || new Prisma.Decimal(sf.amount_paid ?? 0).gt(0)) throw new Error('Discount row changed since the dry run.');
      const allocs = await tx.deposit_allocations.count({ where: { student_fee_id: sf.id } });
      if (allocs > 0) throw new Error(`Discount row #${sf.id} has deposit allocations.`);
      await tx.voucher_heads.delete({ where: { id: r.discount_head_id } });
      await tx.student_fees.delete({ where: { id: sf.id } });
      await tx.vouchers.update({
        where: { id: r.id },
        data: {
          total_payable_before_due: fees,
          total_payable_after_due: fees.add(lateFee),
          paid_pdf_url: null,
          paid_pdf_filename: null,
          paid_pdf_generated_at: null,
          pdf_url: null,
        },
      });
      await tx.audit_logs.create({
        data: {
          entity_type: 'VOUCHER',
          entity_id: String(r.id),
          action: 'UPDATED',
          changed_by: 'script:TAFSD-581',
          student_id: r.student_id,
          section: 'finance',
          note:
            `TAFSD-581: unused discount of ${rs(r.discount)} (row #${sf.id}) removed from Voucher #${r.id} after finance ` +
            `confirmed it was forfeited; the ${rs(recorded)} recorded already covers the full fees. Totals now ` +
            `${rs(fees)} / ${rs(fees.add(lateFee))}; PAID receipt unlinked so it re-renders.`,
        },
      });
    });
    console.log('  applied option B.');
  }
  if (!APPLY) console.log('\nDry run: nothing written.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
