/**
 * TAFSD-546. Cleanup for duplicate fee heads. Dry run by default.
 *
 * What it will delete, and nothing else: an extra copy of a fee head in a
 * group classified DUP_UNBILLED or DUP_ONE_BILLED (classify.ts), where the copy
 * being removed is
 *   - NOT_ISSUED, amount_paid 0,
 *   - on no voucher at all (not even a VOID one, which Rule A can bring back),
 *   - with no deposit allocation,
 *   - not waived, not part of an instalment plan, not a split row.
 * Every one of those is re-checked inside the transaction, under a row lock,
 * immediately before the delete. A copy that has moved on since the audit is
 * skipped, never forced.
 *
 * What it never does: delete or edit a voucher, reverse a deposit, touch a
 * discount row, or change student_fees.amount on any row it keeps. Groups
 * that need any of that (DUP_NEEDS_REVERSAL, UNCLEAR, and every
 * same_month_other_dates group) are listed for finance to unwind through the
 * app's own voucher and deposit flows, newest first (finance CLAUDE.md items
 * 4 and 7), and are left exactly as they are.
 *
 * Because only NOT_ISSUED rows are removed, the Fee Heads report changes in
 * exactly one way: amount and to_be_billed both drop by the removed sum. The
 * caller checks that, and that the report still reconciles, before and after.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { GroupResult } from './classify';

export interface PlannedRemoval {
  student_fee_id: number;
  student_id: number;
  group_key: string;
  keep_id: number;
  fee_type_id: number | null;
  academic_year: string;
  fee_date: string | null;
  target_month: number;
  amount: number;
}

export interface CleanupPlan {
  removals: PlannedRemoval[];
  manual: GroupResult[]; // duplicates that need a person and the app's flows
}

export function planCleanup(groups: GroupResult[]): CleanupPlan {
  const removals: PlannedRemoval[] = [];
  const seen = new Set<number>();
  for (const g of groups) {
    if (g.kind !== 'same_fee_date') continue;
    if (g.verdict !== 'DUP_UNBILLED' && g.verdict !== 'DUP_ONE_BILLED')
      continue;
    for (const m of g.months) {
      for (const id of m.remove) {
        if (seen.has(id)) continue;
        const row = g.copies.find((c) => c.id === id)!;
        seen.add(id);
        removals.push({
          student_fee_id: id,
          student_id: g.student_id,
          group_key: g.key,
          keep_id: m.keep!,
          fee_type_id: row.fee_type_id,
          academic_year: row.academic_year,
          fee_date: row.fee_date,
          target_month: row.target_month,
          amount: row.amount,
        });
      }
    }
  }
  const manual = groups.filter(
    (g) => g.verdict === 'DUP_NEEDS_REVERSAL' || g.verdict === 'UNCLEAR',
  );
  return { removals, manual };
}

export interface ApplyResult {
  removed: PlannedRemoval[];
  skipped: Array<PlannedRemoval & { reason: string }>;
}

/**
 * Delete the planned copies, one student at a time, each in its own
 * transaction. Re-checks every condition under FOR UPDATE first.
 */
export async function applyCleanup(
  prisma: PrismaClient,
  plan: CleanupPlan,
  opts: { changedBy: string; reason: string },
): Promise<ApplyResult> {
  const removed: PlannedRemoval[] = [];
  const skipped: ApplyResult['skipped'] = [];
  const byStudent = new Map<number, PlannedRemoval[]>();
  for (const r of plan.removals)
    byStudent.set(r.student_id, [...(byStudent.get(r.student_id) ?? []), r]);

  for (const [studentId, list] of byStudent) {
    await prisma.$transaction(async (tx) => {
      const ids = [
        ...new Set(list.flatMap((r) => [r.student_fee_id, r.keep_id])),
      ];
      const locked = await tx.$queryRaw<
        Array<{
          id: number;
          student_id: number;
          status: string | null;
          amount_paid: Prisma.Decimal | null;
          is_discount: boolean;
          installment_id: number | null;
          description_prefix: string | null;
          split_pair_id: number | null;
        }>
      >`SELECT id, student_id, status::text AS status, amount_paid, is_discount, installment_id, description_prefix, split_pair_id
                FROM student_fees WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
      const byId = new Map(locked.map((r) => [r.id, r]));
      for (const r of list) {
        const row = byId.get(r.student_fee_id);
        const why = await whyNotRemovable(tx, r, row, byId.has(r.keep_id));
        if (why) {
          skipped.push({ ...r, reason: why });
          continue;
        }
        await tx.student_fees.delete({ where: { id: r.student_fee_id } });
        await tx.audit_logs.create({
          data: {
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: String(r.student_fee_id),
            action: 'DELETED',
            section: 'finance',
            changed_by: opts.changedBy,
            student_id: studentId,
            note:
              `TAFSD-546 duplicate cleanup: removed unbilled duplicate fee head #${r.student_fee_id} ` +
              `(fee type ${r.fee_type_id ?? '-'}, ${r.academic_year} month ${r.target_month}, fee date ${r.fee_date ?? '-'}, Rs ${r.amount}); ` +
              `kept #${r.keep_id}. ${opts.reason}`,
          },
        });
        removed.push(r);
      }
    });
  }
  return { removed, skipped };
}

async function whyNotRemovable(
  tx: Prisma.TransactionClient,
  r: PlannedRemoval,
  row:
    | {
        student_id: number;
        status: string | null;
        amount_paid: Prisma.Decimal | null;
        is_discount: boolean;
        installment_id: number | null;
        description_prefix: string | null;
        split_pair_id: number | null;
      }
    | undefined,
  keeperExists: boolean,
): Promise<string | null> {
  if (!row) return 'no longer exists';
  if (!keeperExists) return `the copy to keep (#${r.keep_id}) no longer exists`;
  if (row.student_id !== r.student_id) return 'belongs to another student';
  if (row.is_discount) return 'is a discount row';
  if ((row.status ?? 'NOT_ISSUED') !== 'NOT_ISSUED')
    return `status is now ${row.status}`;
  if (Number(row.amount_paid ?? 0) !== 0)
    return `has Rs ${Number(row.amount_paid)} paid`;
  if (row.installment_id != null) return 'belongs to an instalment plan';
  if (row.description_prefix || row.split_pair_id != null)
    return 'is part of a voucher split';
  const onVoucher = await tx.voucher_heads.count({
    where: { student_fee_id: r.student_fee_id },
  });
  if (onVoucher) return 'is on a voucher now';
  const allocated = await tx.deposit_allocations.count({
    where: { student_fee_id: r.student_fee_id },
  });
  if (allocated) return 'has a deposit allocation';
  const pointedAt = await tx.student_fees.count({
    where: { split_pair_id: r.student_fee_id },
  });
  if (pointedAt) return 'is the balance of a voucher split';
  return null;
}
