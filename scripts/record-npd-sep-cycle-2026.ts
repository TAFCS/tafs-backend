/**
 * TAFSD-430: record the 26 Aug – 25 Sep 2026 security deposit (NPD)
 * installment as taken on every plan that starts in that cycle and has no
 * deduction yet. It was taken outside the system (no payroll run exists for
 * the cycle). The 22 plans the 23 Sep backfill already recorded are skipped.
 *
 *   npx ts-node --transpile-only scripts/record-npd-sep-cycle-2026.ts           # dry run
 *   APPLY=1 npx ts-node --transpile-only scripts/record-npd-sep-cycle-2026.ts   # write
 *
 * Idempotent: a plan with any ledger row is skipped, so a re-run plans nothing.
 */
import { PrismaClient, SecurityDepositStatus, SecurityDepositTransactionType } from '@prisma/client';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
import { money, scheduleJson, shiftScheduleAfterCollection } from '../src/modules/hr/installment-schedule.util';

const prisma = new PrismaClient();
const audit = new AuditLogsService(prisma as never, {} as never);
const APPLY = process.env.APPLY === '1';
const ACTOR = 'record-npd-sep-cycle-2026';
const SEP_CYCLE_START = new Date('2026-08-26T00:00:00.000Z');
const REASON = 'September 2026 NPD (26 Aug – 25 Sep), deducted outside the system.';

(async () => {
  const plans = await prisma.employee_security_deposits.findMany({
    where: { start_period_start: SEP_CYCLE_START, status: SecurityDepositStatus.ACTIVE, transactions: { none: {} } },
    include: { employee_profiles: { select: { employee_code: true, full_name: true, employment_status: true } } },
    orderBy: { id: 'asc' },
  });
  let total = money(0);
  let written = 0;
  for (const plan of plans) {
    const who = plan.employee_profiles;
    if (who.employee_code?.startsWith('TEST')) continue;
    const schedule = Array.isArray(plan.installment_schedule) ? (plan.installment_schedule as number[]) : [];
    const due = money(schedule[0] ?? plan.installment_amount).plus(plan.carried_forward_amount);
    const recovered = money(plan.recovered_amount).plus(due);
    const remaining = money(plan.total_amount).minus(recovered);
    const next = shiftScheduleAfterCollection(plan.installment_schedule, money(plan.installment_amount), true, remaining);
    total = total.plus(due);
    console.log(
      `${who.employee_code} ${who.employment_status} plan #${plan.id}: take ${due.toFixed(0)}, recovered ${recovered.toFixed(0)}/${money(plan.total_amount).toFixed(0)}, next ${next.installment_amount.toFixed(0)} x${next.installment_count}`,
    );
    if (!APPLY) continue;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM employee_security_deposits WHERE id = ${plan.id} FOR UPDATE`;
      const already = await tx.employee_security_deposit_transactions.count({ where: { deposit_id: plan.id } });
      if (already) return;
      const held = recovered.minus(plan.refunded_amount).minus(plan.forfeited_amount);
      await tx.employee_security_deposit_transactions.create({
        data: {
          deposit_id: plan.id,
          type: SecurityDepositTransactionType.DEDUCTION,
          payroll_run_line_id: null,
          due_amount: due,
          amount: due,
          running_balance: held,
          reason: REASON,
          created_by: ACTOR,
        },
      });
      await tx.employee_security_deposits.update({
        where: { id: plan.id },
        data: {
          recovered_amount: recovered,
          carried_forward_amount: 0,
          status: remaining.lte(0) ? SecurityDepositStatus.COMPLETED : SecurityDepositStatus.ACTIVE,
          installment_schedule: scheduleJson(next.schedule),
          installment_count: next.installment_count,
          installment_amount: next.installment_amount,
        },
      });
      written++;
    });
    await audit.log({
      entity_type: 'EMPLOYEE', entity_id: String(plan.employee_id), action: 'SECURITY_DEPOSIT_DEDUCTED',
      changed_by: ACTOR,
      note: `NPD ${due.toFixed(0)} for 26 Aug – 25 Sep 2026 recorded as collected (taken outside the system).`,
    } as never);
  }
  console.log(`${APPLY ? 'Wrote' : 'Would write'} ${APPLY ? written : plans.filter((p) => !p.employee_profiles.employee_code?.startsWith('TEST')).length} deductions, ${total.toFixed(0)} in total.`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
