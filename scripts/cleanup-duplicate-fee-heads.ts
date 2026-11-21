/**
 * TAFSD-546 cleanup of duplicate fee heads. DRY RUN BY DEFAULT.
 *
 *   npx ts-node scripts/cleanup-duplicate-fee-heads.ts                       # dry run: prints the plan, writes nothing
 *   npx ts-node scripts/cleanup-duplicate-fee-heads.ts --apply --changed-by "<name>"
 *
 * It only ever deletes an unbilled extra copy (NOT_ISSUED, nothing paid, on no
 * voucher, no deposit, not waived, not an instalment or split row) from a
 * group the audit classifies as a duplicate. It never deletes or regenerates a
 * voucher, reverses a deposit, or touches a discount row. Duplicates that need
 * any of that are printed for finance to unwind through the app (newest
 * deposit / voucher first) and left alone. Rules: see
 * src/modules/student-fees/duplicate-fee-heads/cleanup.ts.
 *
 * Before and after an --apply it runs the Fee Heads report's own totals and
 * reconciliation check and refuses to proceed (or reports a failure) unless the
 * report reconciles and only amount / to-be-billed / outstanding moved, by
 * exactly the removed sum.
 *
 * Guard: --apply refuses any database that is not on localhost unless
 * TAFSD546_APPLY_REMOTE=finance-reviewed is set. Finance must review the audit
 * sheet (scripts/audit-duplicate-fee-heads.ts) before that is ever set.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { loadAudit } from '../src/modules/student-fees/duplicate-fee-heads/load';
import { VERDICT_LABEL } from '../src/modules/student-fees/duplicate-fee-heads/classify';
import {
  applyCleanup,
  planCleanup,
} from '../src/modules/student-fees/duplicate-fee-heads/cleanup';
import {
  expectedDelta,
  feeHeadsCheck,
} from '../src/modules/student-fees/duplicate-fee-heads/reconcile';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function dbHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const changedBy = arg('--changed-by');
  const host = dbHost();
  const local = ['localhost', '127.0.0.1', '::1', 'postgres'].includes(host);
  if (apply) {
    if (!changedBy)
      throw new Error('--apply needs --changed-by "<name>" for the audit log.');
    if (!local && process.env.TAFSD546_APPLY_REMOTE !== 'finance-reviewed') {
      throw new Error(
        `Refusing to --apply against ${host || 'an unknown host'}: set TAFSD546_APPLY_REMOTE=finance-reviewed only after finance has signed off the review sheet.`,
      );
    }
  }

  const prisma = new PrismaClient();
  try {
    console.log(
      `${apply ? 'APPLY' : 'DRY RUN'} against ${host || '(unknown host)'}\n`,
    );
    const before = await feeHeadsCheck(prisma);
    console.log(
      `Fee Heads report before: amount ${before.totals.amount}, billed ${before.totals.billed}, to be billed ${before.totals.to_be_billed}, paid ${before.totals.amount_paid}, outstanding ${before.totals.outstanding}, waived ${before.totals.waived}; reconciles: ${before.reconciles}`,
    );
    if (!before.reconciles)
      throw new Error(
        'The Fee Heads report does not reconcile before the cleanup; fix that first.',
      );

    const data = await loadAudit(prisma);
    const plan = planCleanup(data.groups);
    const sum = plan.removals.reduce((s, r) => s + r.amount, 0);

    console.log(`\nGroups audited: ${data.groups.length}`);
    console.log(
      `Unbilled duplicate copies to delete: ${plan.removals.length} (Rs ${sum} of to-be-billed)`,
    );
    for (const r of plan.removals) {
      console.log(
        `  delete #${r.student_fee_id} (CC ${r.student_id}, fee type ${r.fee_type_id ?? '-'}, ${r.academic_year} month ${r.target_month}, fee date ${r.fee_date ?? '-'}, Rs ${r.amount}); keep #${r.keep_id}`,
      );
    }
    console.log(
      `\nLeft for finance (not touched by this script): ${plan.manual.length}`,
    );
    for (const g of plan.manual)
      console.log(
        `  CC ${g.student_id} ${g.key}: ${VERDICT_LABEL[g.verdict]}. ${g.action}`,
      );

    if (!apply) {
      console.log('\nDry run: nothing was written.');
      return;
    }
    if (!plan.removals.length) {
      console.log('\nNothing to delete.');
      return;
    }

    const result = await applyCleanup(prisma, plan, {
      changedBy: changedBy!,
      reason: 'Reviewed by finance on the TAFSD-546 sheet.',
    });
    console.log(
      `\nDeleted ${result.removed.length}; skipped ${result.skipped.length}.`,
    );
    for (const s of result.skipped)
      console.log(`  skipped #${s.student_fee_id}: ${s.reason}`);

    const after = await feeHeadsCheck(prisma);
    const removedSum = result.removed.reduce((s, r) => s + r.amount, 0);
    const drift = expectedDelta(
      before.totals,
      after.totals,
      removedSum,
      result.removed.length,
    );
    console.log(
      `Fee Heads report after: amount ${after.totals.amount}, to be billed ${after.totals.to_be_billed}; reconciles: ${after.reconciles}`,
    );
    if (!after.reconciles || drift.length) {
      // Other activity on a live database between the two reads also moves
      // these totals, so on production read this as "check", not "corrupt".
      console.error(
        `Fee Heads report check FAILED: ${[...(after.reconciles ? [] : ['does not reconcile']), ...drift].join('; ')}`,
      );
      process.exitCode = 2;
    } else {
      console.log(
        'Fee Heads report reconciles, and only amount / to-be-billed / outstanding moved, by the removed sum.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
