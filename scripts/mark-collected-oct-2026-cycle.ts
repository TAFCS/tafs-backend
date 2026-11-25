/**
 * TAFSD-588: record the October 2026 cycle (26 Sep – 25 Oct) security deposit
 * (NPD) and loan installments as collected outside payroll, for employees who
 * are ACTIVE today. No payroll ran in the system for that cycle (checked on
 * production 2026-11-25), so no slot has been taken yet and nothing is charged
 * twice.
 *
 * Decisions (Aawaiz, on #588):
 *  - "Active" = employment_status ACTIVE today. LEFT / TERMINATED are left out.
 *  - A plan with 0 scheduled for October (HR skipped that month: Laiba Ahmed,
 *    Faiza Khan, Yusra Paracha; Muhammad Ahmed's loan) gets October recorded
 *    as skipped (0), the way payroll would, so November collects as planned.
 *  - Amount = the plan's scheduled October installment.
 *  - A loan given after the cycle ended (Shakeela, 28 Oct) is left out.
 *
 * Every write goes through the same service path as the TAFSD-589 "Mark
 * collected" button (`collectNextInstallment`), with period_start pinned to
 * 26 Sep, so a plan whose next cycle is no longer October is refused.
 * Re-running plans nothing.
 *
 *   npx ts-node --transpile-only scripts/mark-collected-oct-2026-cycle.ts            # dry run (read-only) + review sheet
 *   APPLY=1 npx ts-node --transpile-only scripts/mark-collected-oct-2026-cycle.ts    # write
 *
 * SHEET=<path.xlsx> overrides where the review sheet is written.
 */
import ExcelJS from 'exceljs';
import { EmployeeStatus, LoanStatus, Prisma, PrismaClient, SecurityDepositStatus } from '@prisma/client';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
import { EmployeeLoansService } from '../src/modules/hr/employee-loans/employee-loans.service';
import { SecurityDepositsService } from '../src/modules/hr/security-deposits/security-deposits.service';
import { cycleEnd, cycleLabel, nextCollectionCycle } from '../src/modules/hr/installment-cycles.util';
import { money, nextScheduledAmount } from '../src/modules/hr/installment-schedule.util';

const APPLY = process.env.APPLY === '1';
const ACTOR = 'tafsd-588-oct-2026-cycle';
const CYCLE = new Date('2026-09-26T00:00:00.000Z');
const CYCLE_ISO = '2026-09-26';
const NOTES = 'October 2026 payroll (26 Sep – 25 Oct) was done outside the system (TAFSD-588).';
const SHEET = process.env.SHEET ?? `/Users/no.9/Aawaiz/TAFS/tafsd-588-oct-2026-npd-loan-${APPLY ? 'applied' : 'review'}.xlsx`;

const prisma = new PrismaClient();
const audit = new AuditLogsService(prisma as never, {} as never);
const deposits = new SecurityDepositsService(prisma as never, audit, {} as never);
const loans = new EmployeeLoansService(prisma as never, audit, deposits, {} as never);

type Row = {
  kind: 'NPD' | 'Loan';
  plan_id: number;
  employee_id: number;
  code: string;
  name: string;
  campus: string;
  status: string;
  scheduled: number;
  recorded: number;
  note: string;
  target: number;
  collected_before: number;
  collected_after: number;
  balance_before: number;
  balance_after: number;
};
type LeftOut = { kind: string; code: string; name: string; campus: string; status: string; amount: number; reason: string };

const n = (v: Prisma.Decimal | number) => Number(money(v).toFixed(2));
const TXN_SELECT = {
  id: true,
  type: true,
  created_at: true,
  payroll_run_line_id: true,
  payroll_run_line: { select: { payroll_runs: { select: { period_start: true } } } },
} as const;
const WHO = { select: { employee_code: true, full_name: true, employment_status: true, campuses: { select: { campus_name: true } } } } as const;

async function plan(): Promise<{ rows: Row[]; leftOut: LeftOut[] }> {
  const rows: Row[] = [];
  const leftOut: LeftOut[] = [];

  const npd = await prisma.employee_security_deposits.findMany({
    where: { status: SecurityDepositStatus.ACTIVE },
    include: { employee_profiles: WHO, transactions: { select: TXN_SELECT } },
    orderBy: { id: 'asc' },
  });
  for (const p of npd) {
    const who = p.employee_profiles;
    if (who.employee_code?.startsWith('TEST')) continue;
    if (nextCollectionCycle(p.start_period_start, p.transactions).getTime() !== CYCLE.getTime()) continue;
    const remaining = money(p.total_amount).minus(p.recovered_amount);
    const due = Prisma.Decimal.min(nextScheduledAmount(p.installment_schedule, money(p.installment_amount)).plus(p.carried_forward_amount), remaining);
    const base = { code: who.employee_code ?? '', name: who.full_name ?? '', campus: who.campuses?.campus_name ?? '', status: who.employment_status };
    if (who.employment_status !== EmployeeStatus.ACTIVE) {
      leftOut.push({ kind: 'NPD', ...base, amount: n(due), reason: `Employee is ${who.employment_status}, not ACTIVE` });
      continue;
    }
    rows.push({
      kind: 'NPD',
      plan_id: p.id,
      employee_id: p.employee_id,
      ...base,
      scheduled: n(due),
      recorded: n(due),
      note: due.lte(0) ? 'October skipped (0 scheduled); slot recorded so November collects as planned' : '',
      target: n(p.total_amount),
      collected_before: n(p.recovered_amount),
      collected_after: n(money(p.recovered_amount).plus(due)),
      balance_before: n(remaining),
      balance_after: n(remaining.minus(due)),
    });
  }

  const ln = await prisma.employee_loans.findMany({
    where: { status: LoanStatus.ACTIVE },
    include: { employee_profiles: WHO, transactions: { select: TXN_SELECT } },
    orderBy: { id: 'asc' },
  });
  for (const l of ln) {
    const who = l.employee_profiles;
    if (who.employee_code?.startsWith('TEST')) continue;
    if (nextCollectionCycle(l.start_period_start, l.transactions).getTime() !== CYCLE.getTime()) continue;
    const outstanding = Prisma.Decimal.max(
      0,
      money(l.total_amount).minus(l.amount_repaid_opening).minus(l.recovered_amount).minus(l.lump_sum_repaid_amount).minus(l.written_off_amount),
    );
    const due = Prisma.Decimal.min(nextScheduledAmount(l.installment_schedule, money(l.installment_amount)).plus(l.carried_forward_amount), outstanding);
    const base = { code: who.employee_code ?? '', name: who.full_name ?? '', campus: who.campuses?.campus_name ?? '', status: who.employment_status };
    if (who.employment_status !== EmployeeStatus.ACTIVE) {
      leftOut.push({ kind: 'Loan', ...base, amount: n(due), reason: `Employee is ${who.employment_status}, not ACTIVE` });
      continue;
    }
    if (l.disbursement_date > cycleEnd(CYCLE)) {
      leftOut.push({ kind: 'Loan', ...base, amount: n(due), reason: `Loan given on ${l.disbursement_date.toISOString().slice(0, 10)}, after the cycle ended` });
      continue;
    }
    rows.push({
      kind: 'Loan',
      plan_id: l.id,
      employee_id: l.employee_id,
      ...base,
      scheduled: n(due),
      recorded: n(due),
      note: due.lte(0) ? 'October skipped (0 scheduled); slot recorded so November collects as planned' : '',
      target: n(money(l.total_amount).minus(l.amount_repaid_opening)),
      collected_before: n(l.recovered_amount),
      collected_after: n(money(l.recovered_amount).plus(due)),
      balance_before: n(outstanding),
      balance_after: n(outstanding.minus(due)),
    });
  }
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.campus.localeCompare(b.campus) || a.code.localeCompare(b.code));
  leftOut.sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code));
  return { rows, leftOut };
}

async function writeSheet(rows: Row[], leftOut: LeftOut[], results: Map<string, string>) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(APPLY ? 'Marked collected' : 'Will be marked');
  ws.columns = [
    { header: 'Type', key: 'kind', width: 7 },
    { header: 'Employee code', key: 'code', width: 16 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Campus', key: 'campus', width: 24 },
    { header: 'Cycle', key: 'cycle', width: 22 },
    { header: 'October installment', key: 'recorded', width: 18 },
    { header: 'Plan total', key: 'target', width: 12 },
    { header: 'Collected before', key: 'collected_before', width: 16 },
    { header: 'Collected after', key: 'collected_after', width: 16 },
    { header: 'Balance before', key: 'balance_before', width: 15 },
    { header: 'Balance after', key: 'balance_after', width: 14 },
    { header: 'Note', key: 'note', width: 60 },
    ...(APPLY ? [{ header: 'Result', key: 'result', width: 40 }] : []),
  ];
  for (const r of rows) ws.addRow({ ...r, cycle: cycleLabel(CYCLE), result: results.get(`${r.kind}:${r.plan_id}`) ?? '' });
  for (const kind of ['NPD', 'Loan'] as const) {
    const these = rows.filter((r) => r.kind === kind);
    ws.addRow({ kind: '', name: `${kind} total: ${these.length} employees`, recorded: these.reduce((s, r) => s + r.recorded, 0) });
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const lo = wb.addWorksheet('Left out');
  lo.columns = [
    { header: 'Type', key: 'kind', width: 7 },
    { header: 'Employee code', key: 'code', width: 16 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Campus', key: 'campus', width: 24 },
    { header: 'Employment status', key: 'status', width: 18 },
    { header: 'October installment', key: 'amount', width: 18 },
    { header: 'Why left out', key: 'reason', width: 50 },
  ];
  for (const r of leftOut) lo.addRow(r);
  lo.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(SHEET);
}

(async () => {
  const { rows, leftOut } = await plan();
  const results = new Map<string, string>();
  let written = 0;

  for (const r of rows) {
    console.log(
      `${r.kind.padEnd(4)} ${r.code.padEnd(15)} ${r.name.padEnd(28)} ${String(r.recorded).padStart(8)}  balance ${r.balance_before} -> ${r.balance_after}${r.note ? '  (skipped slot)' : ''}`,
    );
    if (!APPLY) continue;
    try {
      const svc = r.kind === 'NPD' ? deposits : loans;
      const out = await prisma.$transaction((tx) =>
        svc.collectNextInstallment(r.employee_id, { amount: r.recorded, notes: NOTES, periodStart: CYCLE_ISO }, ACTOR, tx as never),
      );
      await audit.log({
        entity_type: 'EMPLOYEE',
        entity_id: String(r.employee_id),
        action: r.kind === 'NPD' ? 'SECURITY_DEPOSIT_MARKED_COLLECTED' : 'LOAN_MARKED_COLLECTED',
        changed_by: ACTOR,
        note: `${r.kind === 'NPD' ? 'Security deposit' : 'Loan'} installment for ${cycleLabel(out.period_start)} marked collected outside payroll: ${out.amount.toFixed(2)}. ${NOTES}`,
      } as never);
      results.set(`${r.kind}:${r.plan_id}`, 'marked');
      written++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.set(`${r.kind}:${r.plan_id}`, `REFUSED: ${msg}`);
      console.error(`  refused: ${msg}`);
    }
  }

  console.log('\nLeft out:');
  for (const r of leftOut) console.log(`${r.kind.padEnd(4)} ${r.code.padEnd(15)} ${r.name.padEnd(28)} ${String(r.amount).padStart(8)}  ${r.reason}`);

  const sum = (kind: string) => rows.filter((r) => r.kind === kind).reduce((s, r) => s + r.recorded, 0);
  const count = (kind: string) => rows.filter((r) => r.kind === kind).length;
  console.log(
    `\n${APPLY ? `Wrote ${written} of ${rows.length}` : `Would write ${rows.length}`}: NPD ${count('NPD')} (${sum('NPD')}), loans ${count('Loan')} (${sum('Loan')}). Left out ${leftOut.length}.`,
  );
  await writeSheet(rows, leftOut, results);
  console.log(`Sheet: ${SHEET}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
