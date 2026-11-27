/**
 * TAFSD-613 data fix: bring back CC 7542's voucher #14186 exactly as issued.
 *
 * #14186 (no. 11260014186) was issued on 24 Oct 2026: Sep balance Rs 9,000 and
 * Oct tuition Rs 15,000 as arrears, one Rs 1,000 arrear surcharge (Oct) and Nov
 * tuition Rs 15,000. Rs 40,000 by 9 Nov, Rs 41,000 after, valid to 12 Nov.
 *
 * On 25 Nov a Rs 40,000 cash deposit (#7144) was recorded against it, the
 * voucher was split with "don't generate balance voucher" (PAID #15439), and
 * then the deposit was cleared. Clearing deleted #15439 but did not undo the
 * split: #14186 stayed VOID with no heads, and Sep balance (34466) and Oct
 * (34467) stayed PAID with no deposit behind them. The student has had no live
 * voucher since.
 *
 * This puts #14186 back the way the clean split-undo would have:
 *   - 34466 and 34467: amount_paid 0, ISSUED. 34468 (Nov): ISSUED.
 *   - #14186's three heads recreated at their issued amounts.
 *   - its Oct surcharge (row 5426) back to unpaid; late_fee_deposited 0.
 *   - status EXPIRED (its validity date, 12 Nov, has passed); dates, number,
 *     totals and the stored challan PDF are unchanged, since they still match.
 * The Rs 40,000 itself is not re-recorded here: that is a deposit on the
 * deposit page, once finance confirms the cash was received.
 *
 *   npx ts-node -T -r dotenv/config scripts/fix-tafsd-613-cc7542-restore-14186.ts            # dry run
 *   TAFSD613_APPLY=restore-14186 npx ts-node -T -r dotenv/config \
 *     scripts/fix-tafsd-613-cc7542-restore-14186.ts --apply                                   # write
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const CC = 7542;
const VOUCHER = 14186;
const SURCHARGE_ROW = 5426;
// student_fee_id, issued amount, description prefix, as printed on the challan.
const HEADS: Array<{ sf: number; amount: number; prefix: string | null }> = [
  { sf: 34466, amount: 9000, prefix: 'BALANCE PAYMENT OF' }, // Sep balance
  { sf: 34467, amount: 15000, prefix: null }, // Oct
  { sf: 34468, amount: 15000, prefix: null }, // Nov
];
const LIVE = ['UNPAID', 'OVERDUE', 'EXPIRED', 'PARTIALLY_PAID'];

async function main() {
  if (APPLY && process.env.TAFSD613_APPLY !== 'restore-14186') {
    throw new Error('--apply needs TAFSD613_APPLY=restore-14186.');
  }
  const sfIds = HEADS.map((h) => h.sf);

  await prisma.$transaction(
    async (tx) => {
      // ── Guards: the state found on 27 Nov, and nothing since. ──────────────
      const v = await tx.vouchers.findUniqueOrThrow({ where: { id: VOUCHER } });
      const fail = (m: string) => {
        throw new Error(`Refusing: ${m}`);
      };
      if (v.student_id !== CC) fail(`#${VOUCHER} is not CC ${CC}'s`);
      if (v.status !== 'VOID') fail(`#${VOUCHER} is ${v.status}, expected VOID`);
      if (n(v.total_payable_before_due) !== 40000 || n(v.total_payable_after_due) !== 41000) fail('totals changed');
      if ((await tx.voucher_heads.count({ where: { voucher_id: VOUCHER } })) !== 0) fail(`#${VOUCHER} already has heads`);
      if ((await tx.deposit_allocations.count({ where: { voucher_id: VOUCHER } })) !== 0) fail(`#${VOUCHER} has allocations`);
      if ((await tx.vouchers.count({ where: { split_parent_id: VOUCHER } })) !== 0) fail(`#${VOUCHER} still has split children`);
      const live = await tx.vouchers.findMany({ where: { student_id: CC, status: { in: LIVE } }, select: { id: true } });
      if (live.length) fail(`CC ${CC} already has a live voucher (${live.map((x) => x.id).join(', ')})`);

      const fees = await tx.student_fees.findMany({ where: { id: { in: sfIds } } });
      const byId = new Map(fees.map((f) => [f.id, f]));
      for (const h of HEADS) {
        const f = byId.get(h.sf);
        if (!f || f.student_id !== CC) fail(`fee ${h.sf} missing`);
        if (n(f!.amount) !== h.amount) fail(`fee ${h.sf} amount is ${n(f!.amount)}, expected ${h.amount}`);
        const allocs = await tx.deposit_allocations.count({ where: { student_fee_id: h.sf } });
        if (allocs !== 0) fail(`fee ${h.sf} has ${allocs} deposit allocation(s)`);
        const onLive = await tx.voucher_heads.count({ where: { student_fee_id: h.sf, vouchers: { status: { not: 'VOID' } } } });
        if (onLive !== 0) fail(`fee ${h.sf} is on a non-VOID voucher`);
      }
      const sur = await tx.voucher_arrear_surcharges.findUniqueOrThrow({ where: { id: SURCHARGE_ROW } });
      if (sur.voucher_id !== VOUCHER || n(sur.amount) !== 1000 || sur.waived) fail('surcharge row changed');
      if ((await tx.deposit_allocations.count({ where: { surcharge_id: SURCHARGE_ROW } })) !== 0) fail('surcharge row has allocations');

      // ── Plan ──────────────────────────────────────────────────────────────
      console.log(`#${VOUCHER} (no. ${v.voucher_number}) CC ${CC}: VOID → EXPIRED; issue ${d(v.issue_date)}, due ${d(v.due_date)}, valid ${d(v.validity_date)}, fee date ${d(v.fee_date)}`);
      for (const h of HEADS) {
        const f = byId.get(h.sf)!;
        console.log(`  fee ${h.sf} (month ${f.target_month}): ${f.status} paid ${n(f.amount_paid)} → ISSUED paid 0; head ${h.amount}${h.prefix ? ` "${h.prefix}"` : ''}`);
      }
      console.log(`  surcharge row ${SURCHARGE_ROW}: paid ${n(sur.amount_paid)} → 0; late_fee_deposited ${n(v.late_fee_deposited)} → 0`);
      console.log(`  totals unchanged: ${n(v.total_payable_before_due)} / ${n(v.total_payable_after_due)}; stored challan PDF kept`);
      if (!APPLY) {
        console.log('Dry run: nothing written.');
        return;
      }

      // ── Write ─────────────────────────────────────────────────────────────
      await tx.student_fees.updateMany({
        where: { id: { in: sfIds } },
        data: { amount_paid: new Prisma.Decimal(0), status: 'ISSUED' },
      });
      await tx.voucher_heads.createMany({
        data: HEADS.map((h) => ({
          voucher_id: VOUCHER,
          student_fee_id: h.sf,
          discount_amount: new Prisma.Decimal(0),
          net_amount: new Prisma.Decimal(h.amount),
          amount_deposited: new Prisma.Decimal(0),
          balance: new Prisma.Decimal(h.amount),
          description_prefix: h.prefix,
          scholarship_amount: new Prisma.Decimal(0),
        })),
      });
      await tx.voucher_arrear_surcharges.update({ where: { id: SURCHARGE_ROW }, data: { amount_paid: new Prisma.Decimal(0) } });
      await tx.vouchers.update({
        where: { id: VOUCHER },
        data: { status: 'EXPIRED', late_fee_deposited: new Prisma.Decimal(0), superseded_by_voucher_id: null },
      });
      await tx.audit_logs.create({
        data: {
          entity_type: 'VOUCHER',
          entity_id: String(VOUCHER),
          action: 'UPDATED',
          field: 'status',
          old_value: 'VOID',
          new_value: 'EXPIRED',
          changed_by: 'script:TAFSD-613',
          student_id: CC,
          section: 'finance',
          note:
            `TAFSD-613: Voucher #${VOUCHER} (no. ${v.voucher_number}) restored as issued on 24 Oct 2026. Clearing deposit #7144 on 25 Nov ` +
            `deleted split receipt #15439 without undoing the split, leaving Sep balance and Oct tuition marked paid with no money. ` +
            `Sep balance Rs 9,000, Oct Rs 15,000, Nov Rs 15,000 and the Oct surcharge Rs 1,000 are unpaid again; ` +
            `Rs 40,000 by due date, Rs 41,000 after. Status EXPIRED (valid to 12 Nov).`,
        },
      });
      console.log('Applied.');
    },
    { timeout: 30000 },
  );
}

function n(v: unknown) {
  return Number(v ?? 0);
}
function d(v: Date | null) {
  return v ? v.toISOString().slice(0, 10) : '-';
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
