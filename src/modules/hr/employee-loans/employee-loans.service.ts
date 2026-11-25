import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  EmployeeStatus,
  LoanStatus,
  LoanTransactionType,
  Prisma,
  employee_loans,
} from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { ScopeService } from '../../../common/scope/scope.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { auditActorLabel } from '../../../common/utils/audit-actor.util';
import { computePayrollWindow, currentPayrollPeriodLabel, parsePayrollPeriod } from '../payroll/payroll-period.util';
import { SecurityDepositsService } from '../security-deposits/security-deposits.service';
import {
  assertScheduleMatchesRemaining,
  buildCreateSchedule,
  money,
  nextScheduledAmount,
  scheduleAsNumbers,
  scheduleJson,
  restoreScheduleBeforeCollection,
  shiftScheduleAfterCollection,
} from '../installment-schedule.util';
import {
  type CycleTxn,
  coveredCycles,
  cycleCollectedOutsidePayroll,
  cycleEnd,
  cycleLabel,
  dateOnly,
  nextCollectionCycle,
  parseCycleStart,
} from '../installment-cycles.util';
import { BulkMarkInstallmentsCollectedDto, MarkInstallmentCollectedDto } from '../security-deposits/dto/security-deposits.dto';
import { CreateLoanDto, LumpSumRepaymentDto, UpdateLoanInstallmentScheduleDto, WriteOffLoanDto } from './dto/employee-loans.dto';
import { assertMayChangeEmployee } from '../../../common/auth/super-admin';

const ZERO = new Prisma.Decimal(0);
const OPEN_STATUSES: LoanStatus[] = [LoanStatus.ACTIVE, LoanStatus.OUTSTANDING];
const OFFBOARDED_STATUSES: EmployeeStatus[] = [EmployeeStatus.LEFT, EmployeeStatus.TERMINATED];

type Tx = Prisma.TransactionClient;

function currentCycleStart(): Date {
  const { year, month } = parsePayrollPeriod(currentPayrollPeriodLabel());
  return computePayrollWindow(year, month).periodStart;
}

function shiftCycleStart(periodStart: Date, months: number): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + months, 26));
}

/** Snaps any date to the start of the 26th-25th cycle that contains it. */
function snapToCycleStart(date: Date): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  return date.getUTCDate() >= 26 ? new Date(Date.UTC(y, m, 26)) : new Date(Date.UTC(y, m - 1, 26));
}

@Injectable()
export class EmployeeLoansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly securityDeposits: SecurityDepositsService,
    private readonly scope: ScopeService,
  ) {}

  async getForEmployee(employeeId: number, user?: IJwtStaffPayload) {
    await this.assertEmployee(employeeId, user);
    const loans = await this.prisma.employee_loans.findMany({
      where: { employee_id: employeeId },
      include: {
        transactions: {
          include: {
            payroll_run_line: {
              select: {
                id: true,
                payroll_runs: { select: { period_start: true, period_end: true } },
              },
            },
          },
          orderBy: { created_at: 'asc' },
        },
      },
      orderBy: { created_at: 'desc' },
    });
    const current = loans.find((l) => OPEN_STATUSES.includes(l.status)) ?? null;
    const history = loans.filter((l) => l.id !== current?.id);
    return {
      current: current ? this.serializeLoan(current, true) : null,
      history: history.map((l) => this.serializeLoan(l, false)),
      default_start_period_start: dateOnly(await this.defaultStartFor(employeeId)),
    };
  }

  /**
   * Earliest cycle a new loan may start in. The cycle that just ended stays
   * open until this employee's real payroll for it is finalized, so a loan
   * recorded on the 27th can still be recovered from that month's salary
   * (TAFSD-435).
   */
  private async defaultStartFor(employeeId: number): Promise<Date> {
    const current = currentCycleStart();
    const previous = shiftCycleStart(current, -1);
    const finalized = await this.prisma.payroll_run_lines.findFirst({
      where: {
        employee_id: employeeId,
        finalized_at: { not: null },
        payroll_runs: { period_start: previous, is_test: false },
      },
      select: { id: true },
    });
    return finalized ? current : previous;
  }

  async listOpen(user: IJwtStaffPayload, status?: LoanStatus) {
    const statuses = status ? [status] : OPEN_STATUSES;
    const where: Prisma.employee_loansWhereInput = {
      status: { in: statuses },
    };
    const employeeProfileClauses: Prisma.employee_profilesWhereInput[] = [];
    const universal = this.scope.whereForEmployees(user);
    if (Object.keys(universal).length > 0) {
      employeeProfileClauses.push(universal);
    }
    if (employeeProfileClauses.length > 0) {
      where.employee_profiles = { AND: employeeProfileClauses };
    }

    const loans = await this.prisma.employee_loans.findMany({
      where,
      include: {
        employee_profiles: {
          select: {
            id: true,
            full_name: true,
            employee_code: true,
            campuses: { select: { campus_name: true } },
          },
        },
        transactions: {
          where: { type: LoanTransactionType.DEDUCTION },
          select: {
            id: true,
            type: true,
            created_at: true,
            payroll_run_line_id: true,
            payroll_run_line: { select: { payroll_runs: { select: { period_start: true } } } },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { start_period_start: 'desc' }, { id: 'desc' }],
    });
    return loans.map((loan) => this.serializeListRow(loan));
  }

  async create(employeeId: number, dto: CreateLoanDto, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'loan');
    await this.assertEmployee(employeeId, user);
    const open = await this.prisma.employee_loans.findFirst({
      where: { employee_id: employeeId, status: LoanStatus.ACTIVE },
    });
    if (open) {
      throw new ConflictException('This employee already has an active loan.');
    }

    const total = money(dto.total_amount);
    const opening = money(dto.amount_repaid_opening ?? 0);
    if (opening.gte(total)) {
      throw new BadRequestException('Opening repaid amount must be less than the total loan amount.');
    }
    const remaining = total.minus(opening);
    const schedule = buildCreateSchedule(remaining, dto.installment_count, dto.installment_amounts);
    if (schedule.length === 0) {
      throw new BadRequestException('Installment amount must be greater than zero. Increase the total or reduce the number of months.');
    }
    const disbursedAt = dto.disbursement_date
      ? new Date(`${dto.disbursement_date.slice(0, 10)}T00:00:00.000Z`)
      : new Date(`${dateOnly(new Date())}T00:00:00.000Z`);
    const start = dto.start_period_start
      ? snapToCycleStart(new Date(`${dto.start_period_start.slice(0, 10)}T00:00:00.000Z`))
      : await this.defaultStartFor(employeeId);

    await this.prisma.$transaction(async (tx) => {
      let loan: employee_loans;
      try {
        loan = await tx.employee_loans.create({
          data: {
            employee_id: employeeId,
            total_amount: total,
            amount_repaid_opening: opening,
            installment_count: schedule.length,
            installment_amount: money(schedule[0]),
            installment_schedule: scheduleJson(schedule),
            disbursement_date: disbursedAt,
            start_period_start: start,
            notes: dto.notes?.trim() || null,
            created_by: user.sub,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException('This employee already has an active loan.');
        }
        throw err;
      }
      if (opening.gt(0)) {
        await tx.employee_loan_transactions.create({
          data: {
            loan_id: loan.id,
            type: LoanTransactionType.OPENING_BALANCE,
            due_amount: opening,
            amount: opening,
            balance_after: remaining,
            reason: 'Amount already repaid before this system tracked the loan.',
            created_by: user.sub,
          },
        });
      }
      await this.recapOpenDraftLines(employeeId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'LOAN_CREATED',
      changed_by: auditActorLabel(user),
      note: `Recorded a loan of ${total.toFixed(2)} (${opening.toFixed(2)} already repaid) over ${schedule.length} month(s), starting ${dateOnly(start)}.`,
    });

    return this.getForEmployee(employeeId);
  }

  async updateSchedule(employeeId: number, dto: UpdateLoanInstallmentScheduleDto, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'loan');
    await this.prisma.$transaction(async (tx) => {
      await this.assertEmployee(employeeId, user, tx);
      const loan = await tx.employee_loans.findFirst({
        where: { employee_id: employeeId, status: LoanStatus.ACTIVE },
      });
      if (!loan) {
        throw new NotFoundException('No collecting loan for this employee.');
      }
      const remaining = this.outstandingBalance(loan);
      if (remaining.lte(0)) {
        throw new BadRequestException('There is nothing left to collect on this loan.');
      }
      const schedule = assertScheduleMatchesRemaining(dto.installment_amounts, remaining);
      await tx.employee_loans.update({
        where: { id: loan.id },
        data: {
          installment_schedule: scheduleJson(schedule),
          installment_count: schedule.length,
          installment_amount: money(schedule[0]),
          carried_forward_amount: ZERO,
        },
      });
      await this.recapOpenDraftLines(employeeId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'LOAN_SCHEDULE_UPDATED',
      changed_by: auditActorLabel(user),
      note: `Updated remaining recovery to ${dto.installment_amounts.length} month(s).`,
    });

    return this.getForEmployee(employeeId);
  }

  async repayLumpSum(employeeId: number, dto: LumpSumRepaymentDto, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'loan');
    const amount = money(dto.amount);
    await this.prisma.$transaction(async (tx) => {
      const loan = await this.requireOpenLoan(employeeId, user, tx);
      const outstanding = this.outstandingBalance(loan);
      if (amount.gt(outstanding)) {
        throw new BadRequestException(`Lump-sum repayment cannot exceed the outstanding balance of ${outstanding.toFixed(2)}.`);
      }
      const lumpSum = money(loan.lump_sum_repaid_amount).plus(amount);
      const status = this.nextStatus(loan.total_amount, loan.amount_repaid_opening, loan.recovered_amount, lumpSum, loan.written_off_amount);
      const balanceAfter = this.balanceAfter(loan.total_amount, loan.amount_repaid_opening, loan.recovered_amount, lumpSum, loan.written_off_amount);

      await tx.employee_loan_transactions.create({
        data: {
          loan_id: loan.id,
          type: LoanTransactionType.LUMP_SUM_REPAYMENT,
          due_amount: amount,
          amount,
          balance_after: balanceAfter,
          reason: dto.notes?.trim() || null,
          created_by: user.sub,
        },
      });
      await tx.employee_loans.update({
        where: { id: loan.id },
        data: { lump_sum_repaid_amount: lumpSum, status },
      });
      await this.recapOpenDraftLines(employeeId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'LOAN_LUMP_SUM_REPAID',
      changed_by: auditActorLabel(user),
      note: `Recorded a lump-sum loan repayment of ${amount.toFixed(2)}.${dto.notes ? ` ${dto.notes}` : ''}`,
    });

    return this.getForEmployee(employeeId);
  }

  async writeOff(employeeId: number, dto: WriteOffLoanDto, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'loan');
    const amount = money(dto.amount);
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException('A reason is required to write off a loan.');
    }

    await this.prisma.$transaction(async (tx) => {
      const loan = await this.requireOpenLoan(employeeId, user, tx);
      const outstanding = this.outstandingBalance(loan);
      if (amount.gt(outstanding)) {
        throw new BadRequestException(`Write-off cannot exceed the outstanding balance of ${outstanding.toFixed(2)}.`);
      }
      const writtenOff = money(loan.written_off_amount).plus(amount);
      const status = this.nextStatus(loan.total_amount, loan.amount_repaid_opening, loan.recovered_amount, loan.lump_sum_repaid_amount, writtenOff);
      const balanceAfter = this.balanceAfter(loan.total_amount, loan.amount_repaid_opening, loan.recovered_amount, loan.lump_sum_repaid_amount, writtenOff);

      await tx.employee_loan_transactions.create({
        data: {
          loan_id: loan.id,
          type: LoanTransactionType.WRITE_OFF,
          due_amount: amount,
          amount,
          balance_after: balanceAfter,
          reason,
          created_by: user.sub,
        },
      });
      await tx.employee_loans.update({
        where: { id: loan.id },
        data: { written_off_amount: writtenOff, status },
      });
      await this.recapOpenDraftLines(employeeId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'LOAN_WRITTEN_OFF',
      changed_by: auditActorLabel(user),
      note: `Wrote off ${amount.toFixed(2)} of loan balance. ${reason}`,
    });

    return this.getForEmployee(employeeId);
  }

  async cancel(employeeId: number, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'loan');
    await this.prisma.$transaction(async (tx) => {
      const loan = await this.requireOpenLoan(employeeId, user, tx);
      const hasActivity =
        money(loan.amount_repaid_opening).gt(0) ||
        money(loan.recovered_amount).gt(0) ||
        money(loan.lump_sum_repaid_amount).gt(0) ||
        money(loan.written_off_amount).gt(0);
      if (hasActivity) {
        throw new BadRequestException('Cannot cancel a loan that already has repayment activity. Record a lump-sum repayment or write-off instead.');
      }
      await tx.employee_loans.delete({ where: { id: loan.id } });
      await this.recapOpenDraftLines(employeeId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'LOAN_CANCELLED',
      changed_by: auditActorLabel(user),
      note: 'Cancelled unused loan record.',
    });

    return this.getForEmployee(employeeId);
  }

  async markOutstanding(employeeId: number, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'loan');
    await this.prisma.$transaction(async (tx) => {
      await this.assertEmployee(employeeId, user, tx);
      const loan = await tx.employee_loans.findFirst({
        where: { employee_id: employeeId, status: LoanStatus.ACTIVE },
      });
      if (!loan) {
        throw new NotFoundException('No active loan for this employee.');
      }
      const employee = await tx.employee_profiles.findUnique({
        where: { id: employeeId },
        select: { employment_status: true },
      });
      if (!employee || !OFFBOARDED_STATUSES.includes(employee.employment_status)) {
        throw new BadRequestException('Only loans for employees who have left or been terminated can be marked outstanding.');
      }
      await tx.employee_loans.update({ where: { id: loan.id }, data: { status: LoanStatus.OUTSTANDING } });
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'LOAN_MARKED_OUTSTANDING',
      changed_by: auditActorLabel(user),
      note: 'Flagged loan balance as outstanding for manual follow-up after offboarding.',
    });

    return this.getForEmployee(employeeId);
  }

  /**
   * Snapshot the cycle's loan deduction onto a payroll line after attendance
   * and statutory/flag amounts are already stored. Caps at remaining net so
   * discretionary installments never push pay below zero; loans are applied
   * before caution money, so this must run first and the security-deposit
   * pass (which reads `loan_deduction` back off the line) must run right
   * after it whenever either plan changes.
   */
  async applySnapshotToLine(
    runId: number,
    employeeId: number,
    tx: Tx = this.prisma,
  ): Promise<void> {
    const line = await tx.payroll_run_lines.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
      include: { payroll_runs: { select: { period_start: true } } },
    });
    if (!line) return;

    const base = money(line.absence_deduction)
      .plus(line.half_day_deduction)
      .plus(line.late_deduction)
      .plus(line.early_leave_deduction)
      .plus(line.break_deduction)
      .plus(line.eobi_deduction)
      .plus(line.income_tax_deduction)
      .plus(line.sandwich_deduction)
      .plus(line.after_leaving_deduction)
      .plus(line.consecutive_late_deduction);

    const monthly = money(line.monthly_pay);
    const available = Prisma.Decimal.max(ZERO, monthly.minus(base));

    const loan = await this.findCollectingLoan(employeeId, tx);
    let collected = ZERO;
    if (
      loan &&
      line.payroll_runs.period_start >= loan.start_period_start &&
      !(await this.collectedOutsidePayroll(loan, line.payroll_runs.period_start, tx))
    ) {
      const due = this.cycleDue(loan);
      collected = Prisma.Decimal.min(due, available).toDecimalPlaces(2);
    }

    // The deposit's own pass (which runs right after this one whenever
    // either plan changes) will recompute totals using the fresh value we
    // write here; until then this keeps whatever deposit amount is already
    // stored so total_deductions/net_pay stay internally consistent.
    const depositCurrent = money(line.security_deposit_deduction);
    const totalDeductions = base.plus(collected).plus(depositCurrent).toDecimalPlaces(2);
    const netPay = monthly.minus(totalDeductions).toDecimalPlaces(2);

    await tx.payroll_run_lines.update({
      where: { id: line.id },
      data: {
        loan_deduction: collected,
        total_deductions: totalDeductions,
        net_pay: netPay,
      },
    });
  }

  /** Persist a DEDUCTION ledger row when a non-test line is finalized. Idempotent per loan/line. */
  async commitLineDeduction(lineId: number, createdBy: string, tx: Tx = this.prisma): Promise<void> {
    const line = await tx.payroll_run_lines.findUnique({
      where: { id: lineId },
      include: { payroll_runs: { select: { period_start: true, is_test: true } } },
    });
    if (!line || line.payroll_runs.is_test) return;

    await this.lockEmployeeLoans(line.employee_id, tx);
    const loan = await this.findCollectingLoan(line.employee_id, tx);
    if (!loan) return;
    if (line.payroll_runs.period_start < loan.start_period_start) return;
    // TAFSD-589: this cycle's installment was already collected outside
    // payroll. Its slot is used up; taking the next one would charge twice.
    if (await this.collectedOutsidePayroll(loan, line.payroll_runs.period_start, tx)) return;

    const due = this.cycleDue(loan);
    const amount = money(line.loan_deduction);
    const remainingNow = this.outstandingBalance(loan);
    // A 0 due with remaining balance is a skipped cycle — still consume the slot.
    if (due.lte(0) && amount.lte(0) && remainingNow.lte(0)) return;

    const existing = await tx.employee_loan_transactions.findFirst({
      where: {
        loan_id: loan.id,
        payroll_run_line_id: line.id,
        type: LoanTransactionType.DEDUCTION,
      },
    });
    if (existing) return;

    await this.postCollection(loan, due, amount, { payroll_run_line_id: line.id, reason: null, created_by: createdBy }, tx);
  }

  /**
   * Writes one installment's DEDUCTION and uses up its slot. Payroll and
   * "Mark collected" both go through here, so a slot is consumed the same way
   * whichever took it. False on a duplicate.
   */
  private async postCollection(
    loan: employee_loans,
    due: Prisma.Decimal,
    amount: Prisma.Decimal,
    row: { payroll_run_line_id: number | null; reason: string | null; created_by: string },
    tx: Tx,
  ): Promise<boolean> {
    const recovered = money(loan.recovered_amount).plus(amount);
    const payrollTarget = money(loan.total_amount)
      .minus(loan.amount_repaid_opening)
      .minus(loan.lump_sum_repaid_amount)
      .minus(loan.written_off_amount);
    const carry = recovered.gte(payrollTarget)
      ? ZERO
      : Prisma.Decimal.max(ZERO, due.minus(amount)).toDecimalPlaces(2);
    const status = this.nextStatus(loan.total_amount, loan.amount_repaid_opening, recovered, loan.lump_sum_repaid_amount, loan.written_off_amount);
    const balanceAfter = this.balanceAfter(loan.total_amount, loan.amount_repaid_opening, recovered, loan.lump_sum_repaid_amount, loan.written_off_amount);
    const remainingAfter = balanceAfter;
    const collectedFullDue = amount.gte(due) || remainingAfter.lte(0);
    const shifted = shiftScheduleAfterCollection(
      loan.installment_schedule,
      money(loan.installment_amount),
      collectedFullDue,
      remainingAfter,
    );

    try {
      await tx.employee_loan_transactions.create({
        data: {
          loan_id: loan.id,
          type: LoanTransactionType.DEDUCTION,
          payroll_run_line_id: row.payroll_run_line_id,
          due_amount: due,
          amount,
          balance_after: balanceAfter,
          reason: row.reason ? row.reason.slice(0, 500) : null,
          created_by: row.created_by,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }

    await tx.employee_loans.update({
      where: { id: loan.id },
      data: {
        recovered_amount: recovered,
        carried_forward_amount: carry,
        status,
        installment_schedule: scheduleJson(shifted.schedule),
        installment_count: shifted.installment_count,
        installment_amount: shifted.installment_amount,
      },
    });
    return true;
  }

  /**
   * TAFSD-589: record the next due installment as collected outside payroll
   * (cash, or a payroll run done on paper). It uses up the slot exactly as a
   * finalized payroll line would, so the next payroll takes the cycle after.
   */
  async markCollected(employeeId: number, dto: MarkInstallmentCollectedDto, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'loan');
    const result = await this.prisma.$transaction(async (tx) => {
      await this.assertEmployee(employeeId, user, tx);
      return this.collectNextInstallment(employeeId, { amount: dto.amount, notes: dto.notes, periodStart: dto.period_start }, user.sub, tx);
    });
    this.logCollected(employeeId, result, dto.notes, auditActorLabel(user));
    return this.getForEmployee(employeeId);
  }

  /** TAFSD-589: one cycle, several employees; each its own transaction, refusals reported. */
  async markCollectedBulk(dto: BulkMarkInstallmentsCollectedDto, user: IJwtStaffPayload) {
    const periodStart = parseCycleStart(dto.period_start);
    if (!periodStart) throw new BadRequestException('period_start must be the start of a payroll cycle (the 26th).');
    const results: { employee_id: number; ok: boolean; amount?: number; due_amount?: number; error?: string }[] = [];
    for (const item of dto.items) {
      try {
        await assertMayChangeEmployee(this.prisma, user, item.employee_id, 'loan');
        const result = await this.prisma.$transaction(async (tx) => {
          await this.assertEmployee(item.employee_id, user, tx);
          return this.collectNextInstallment(
            item.employee_id,
            { amount: item.amount, notes: dto.notes, periodStart: dto.period_start },
            user.sub,
            tx,
          );
        });
        this.logCollected(item.employee_id, result, dto.notes, auditActorLabel(user));
        results.push({ employee_id: item.employee_id, ok: true, amount: Number(result.amount), due_amount: Number(result.due) });
      } catch (err) {
        results.push({ employee_id: item.employee_id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      period_start: dateOnly(periodStart),
      marked: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      total_amount: results.reduce((sum, r) => sum + (r.amount ?? 0), 0),
      results,
    };
  }

  /**
   * The shared core of Mark collected (button, bulk, and one-off scripts).
   * Caller owns the transaction and has already checked scope.
   * `periodStart`, when given, must be the loan's next due cycle — that is
   * what makes a repeated bulk call refuse rather than take the next slot.
   */
  async collectNextInstallment(
    employeeId: number,
    opts: { amount?: number; notes: string; periodStart?: string },
    createdBy: string,
    tx: Tx,
  ): Promise<{ loan_id: number; period_start: Date; due: Prisma.Decimal; amount: Prisma.Decimal }> {
    const notes = opts.notes.trim();
    if (!notes) throw new BadRequestException('A note is required to mark an installment collected.');
    await this.lockEmployeeLoans(employeeId, tx);
    const loan = await this.findCollectingLoan(employeeId, tx);
    if (!loan) throw new NotFoundException('This employee has no active loan collecting installments.');
    if (this.outstandingBalance(loan).lte(0)) {
      throw new BadRequestException('Nothing is left to collect on this loan.');
    }
    const cycle = nextCollectionCycle(loan.start_period_start, await this.cycleTransactions(loan.id, tx));
    if (opts.periodStart !== undefined) {
      const expected = parseCycleStart(opts.periodStart);
      if (!expected) throw new BadRequestException('period_start must be the start of a payroll cycle (the 26th).');
      if (expected.getTime() !== cycle.getTime()) {
        throw new ConflictException(`The next installment due is for ${cycleLabel(cycle)}, not ${cycleLabel(expected)}.`);
      }
    }
    if (cycle > currentCycleStart()) {
      throw new BadRequestException(`The next installment is for ${cycleLabel(cycle)}, which hasn't started yet.`);
    }

    const due = this.cycleDue(loan);
    const amount = opts.amount === undefined ? due : money(opts.amount);
    if (amount.lt(0) || amount.gt(due)) {
      throw new BadRequestException(`The amount must be between 0 and the ${due.toFixed(2)} due for ${cycleLabel(cycle)}.`);
    }
    if (due.gt(0) && amount.lte(0)) {
      throw new BadRequestException('Enter the amount collected. To skip a cycle, edit the recovery schedule instead.');
    }
    const what = due.lte(0) ? `${cycleLabel(cycle)} skipped (nothing scheduled)` : `Collected outside payroll for ${cycleLabel(cycle)}`;
    await this.postCollection(loan, due, amount, { payroll_run_line_id: null, reason: `${what}. ${notes}`, created_by: createdBy }, tx);
    await this.recapOpenDraftLines(employeeId, tx);
    return { loan_id: loan.id, period_start: cycle, due, amount };
  }

  /**
   * TAFSD-589: undo an installment recorded outside payroll. Only the loan's
   * latest entry, and only while no payroll for that cycle or a later one has
   * been finalized for the employee.
   */
  async undoCollection(employeeId: number, transactionId: number, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'loan');
    let undone: { amount: Prisma.Decimal; period_start: Date } | null = null;
    await this.prisma.$transaction(async (tx) => {
      await this.assertEmployee(employeeId, user, tx);
      await this.lockEmployeeLoans(employeeId, tx);
      const row = await tx.employee_loan_transactions.findUnique({
        where: { id: transactionId },
        include: { loan: true },
      });
      if (!row || row.loan.employee_id !== employeeId) {
        throw new NotFoundException('Installment not found for this employee.');
      }
      if (row.type !== LoanTransactionType.DEDUCTION || row.payroll_run_line_id !== null) {
        throw new BadRequestException('Only an installment recorded outside payroll can be undone here. A payroll deduction is undone by un-finalizing its payroll line.');
      }
      const cycles = coveredCycles(row.loan.start_period_start, await this.cycleTransactions(row.loan_id, tx));
      const cycle = [...cycles.entries()].find(([t]) => t.id === row.id)?.[1] ?? row.loan.start_period_start;
      const later = await tx.payroll_run_lines.findFirst({
        where: {
          employee_id: employeeId,
          finalized_at: { not: null },
          payroll_runs: { is_test: false, period_start: { gte: cycle } },
        },
        select: { payroll_runs: { select: { period_start: true } } },
      });
      if (later) {
        throw new BadRequestException(
          `This can't be undone: payroll for ${cycleLabel(later.payroll_runs.period_start)} has already been finalized for this employee.`,
        );
      }
      await this.reverseDeductionRow(row, tx, 'undo');
      await this.recapOpenDraftLines(employeeId, tx);
      undone = { amount: money(row.amount), period_start: cycle };
    });

    const done = undone as { amount: Prisma.Decimal; period_start: Date } | null;
    if (done) {
      void this.auditLogs.log({
        entity_type: 'EMPLOYEE',
        entity_id: String(employeeId),
        action: 'LOAN_COLLECTION_UNDONE',
        changed_by: auditActorLabel(user),
        note: `Undid the ${done.amount.toFixed(2)} loan installment recorded outside payroll for ${cycleLabel(done.period_start)}. The slot is due again.`,
      });
    }
    return this.getForEmployee(employeeId);
  }

  /**
   * TAFSD-394: undo commitLineDeduction when a payroll line is un-finalized.
   * Removes the line's DEDUCTION row and puts the amount back on the loan.
   * Refuses if anything was posted to the loan after it — a later cycle,
   * lump sum or write-off read the balance this deduction left behind.
   */
  async reverseLineDeduction(lineId: number, tx: Tx = this.prisma): Promise<void> {
    const rows = await tx.employee_loan_transactions.findMany({
      where: { payroll_run_line_id: lineId, type: LoanTransactionType.DEDUCTION },
    });
    for (const row of rows) {
      await this.reverseDeductionRow(row, tx, 'unfinalize');
    }
  }

  private async reverseDeductionRow(
    row: { id: number; loan_id: number; amount: Prisma.Decimal; due_amount: Prisma.Decimal },
    tx: Tx,
    context: 'unfinalize' | 'undo',
  ): Promise<void> {
    const what = context === 'unfinalize' ? 'This line cannot be un-finalized' : "This installment can't be undone";
    const later = await tx.employee_loan_transactions.count({ where: { loan_id: row.loan_id, id: { gt: row.id } } });
    if (later > 0) {
      throw new BadRequestException(
        `${what}: the loan has later entries (a later installment, lump sum or write-off). Undo those first.`,
      );
    }
    const loan = await tx.employee_loans.findUniqueOrThrow({ where: { id: row.loan_id } });
    const newer = await tx.employee_loans.count({ where: { employee_id: loan.employee_id, id: { gt: loan.id } } });
    if (newer > 0) {
      throw new BadRequestException(`${what}: a newer loan was opened for this employee after this installment.`);
    }
    const recovered = Prisma.Decimal.max(ZERO, money(loan.recovered_amount).minus(row.amount));
    const restored = { ...loan, recovered_amount: recovered };
    const schedule = restoreScheduleBeforeCollection(
      scheduleAsNumbers(loan.installment_schedule, money(loan.installment_amount)),
      money(row.due_amount),
      this.outstandingBalance(restored),
    );
    await tx.employee_loan_transactions.delete({ where: { id: row.id } });
    await tx.employee_loans.update({
      where: { id: loan.id },
      data: {
        recovered_amount: recovered,
        carried_forward_amount: ZERO,
        status: this.nextStatus(loan.total_amount, loan.amount_repaid_opening, recovered, loan.lump_sum_repaid_amount, loan.written_off_amount),
        installment_schedule: scheduleJson(schedule),
        installment_count: schedule.length,
        installment_amount: money(schedule[0] ?? 0),
      },
    });
  }

  private logCollected(
    employeeId: number,
    result: { period_start: Date; due: Prisma.Decimal; amount: Prisma.Decimal },
    notes: string,
    actor: string,
  ): void {
    const short = result.amount.lt(result.due) ? ` of ${result.due.toFixed(2)} due; ${result.due.minus(result.amount).toFixed(2)} carries to the next cycle` : '';
    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'LOAN_MARKED_COLLECTED',
      changed_by: actor,
      note: `Loan installment for ${cycleLabel(result.period_start)} marked collected outside payroll: ${result.amount.toFixed(2)}${short}. ${notes.trim()}`,
    });
  }

  private async cycleTransactions(loanId: number, tx: Tx): Promise<CycleTxn[]> {
    return tx.employee_loan_transactions.findMany({
      where: { loan_id: loanId },
      select: {
        id: true,
        type: true,
        created_at: true,
        payroll_run_line_id: true,
        payroll_run_line: { select: { payroll_runs: { select: { period_start: true } } } },
      },
    });
  }

  private async collectedOutsidePayroll(loan: employee_loans, periodStart: Date, tx: Tx): Promise<boolean> {
    return cycleCollectedOutsidePayroll(loan.start_period_start, await this.cycleTransactions(loan.id, tx), periodStart);
  }

  /** Row lock so a payroll finalize and a Mark collected on the same loan serialize. No-op outside a transaction. */
  private async lockEmployeeLoans(employeeId: number, tx: Tx): Promise<void> {
    await tx.$queryRaw`SELECT id FROM employee_loans WHERE employee_id = ${employeeId} FOR UPDATE`;
  }

  /**
   * A loan change shifts how much room is left for caution money, so every
   * draft line gets the loan pass and then the deposit pass re-run.
   */
  private async recapOpenDraftLines(employeeId: number, tx: Tx): Promise<void> {
    const lines = await tx.payroll_run_lines.findMany({
      where: { employee_id: employeeId, finalized_at: null },
      select: { payroll_run_id: true },
    });
    for (const line of lines) {
      await this.applySnapshotToLine(line.payroll_run_id, employeeId, tx);
      await this.securityDeposits.applySnapshotToLine(line.payroll_run_id, employeeId, tx);
    }
  }

  private outstandingBalance(loan: employee_loans): Prisma.Decimal {
    const balance = money(loan.total_amount)
      .minus(loan.amount_repaid_opening)
      .minus(loan.recovered_amount)
      .minus(loan.lump_sum_repaid_amount)
      .minus(loan.written_off_amount);
    return balance.lt(0) ? ZERO : balance;
  }

  private balanceAfter(
    total: Prisma.Decimal | number | string,
    opening: Prisma.Decimal | number | string,
    recovered: Prisma.Decimal | number | string,
    lumpSum: Prisma.Decimal | number | string,
    writtenOff: Prisma.Decimal | number | string,
  ): Prisma.Decimal {
    const balance = money(total).minus(opening).minus(recovered).minus(lumpSum).minus(writtenOff);
    return balance.lt(0) ? ZERO : balance;
  }

  private cycleDue(loan: employee_loans): Prisma.Decimal {
    const remaining = this.outstandingBalance(loan);
    if (remaining.lte(0)) return ZERO;
    return Prisma.Decimal.min(
      nextScheduledAmount(loan.installment_schedule, money(loan.installment_amount)).plus(loan.carried_forward_amount),
      remaining,
    ).toDecimalPlaces(2);
  }

  /** Close only once the outstanding balance is fully cleared, by whichever mechanism cleared it. */
  private nextStatus(
    total: Prisma.Decimal | number | string,
    opening: Prisma.Decimal | number | string,
    recovered: Prisma.Decimal | number | string,
    lumpSum: Prisma.Decimal | number | string,
    writtenOff: Prisma.Decimal | number | string,
  ): LoanStatus {
    const outstanding = money(total).minus(opening).minus(recovered).minus(lumpSum).minus(writtenOff);
    if (outstanding.gt(0)) return LoanStatus.ACTIVE;
    return this.closedStatus(lumpSum, writtenOff);
  }

  private closedStatus(lumpSum: Prisma.Decimal | number | string, writtenOff: Prisma.Decimal | number | string): LoanStatus {
    if (money(writtenOff).gt(0)) return LoanStatus.WRITTEN_OFF;
    if (money(lumpSum).gt(0)) return LoanStatus.FORECLOSED;
    return LoanStatus.COMPLETED;
  }

  private async findCollectingLoan(employeeId: number, tx: Tx): Promise<employee_loans | null> {
    return tx.employee_loans.findFirst({
      where: { employee_id: employeeId, status: LoanStatus.ACTIVE },
    });
  }

  private async requireOpenLoan(employeeId: number, user: IJwtStaffPayload | undefined, tx: Tx): Promise<employee_loans> {
    await this.assertEmployee(employeeId, user, tx);
    const loan = await tx.employee_loans.findFirst({
      where: { employee_id: employeeId, status: { in: OPEN_STATUSES } },
    });
    if (!loan) {
      throw new NotFoundException('No open loan for this employee.');
    }
    return loan;
  }

  // Missing and out-of-scope both 404 — a 403 would confirm a real employee
  // exists at a campus outside the caller's scope.
  private async assertEmployee(employeeId: number, user?: IJwtStaffPayload, tx: Tx = this.prisma) {
    const employee = await tx.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { id: true, campus_id: true, segment_id: true, department_id: true, staff_category_id: true },
    });
    if (!employee || (user && !this.scope.canSeeEmployee(user, employee))) {
      throw new NotFoundException(`Employee ${employeeId} not found`);
    }
  }

  private serializeListRow(loan: employee_loans & {
    employee_profiles: {
      id: number;
      full_name: string | null;
      employee_code: string | null;
      campuses: { campus_name: string } | null;
    };
    transactions: CycleTxn[];
  }) {
    const total = Number(loan.total_amount);
    return {
      id: loan.id,
      employee_id: loan.employee_id,
      full_name: loan.employee_profiles.full_name,
      employee_code: loan.employee_profiles.employee_code,
      campus_name: loan.employee_profiles.campuses?.campus_name ?? null,
      total_amount: total,
      amount_repaid_opening: Number(loan.amount_repaid_opening),
      recovered_amount: Number(loan.recovered_amount),
      lump_sum_repaid_amount: Number(loan.lump_sum_repaid_amount),
      written_off_amount: Number(loan.written_off_amount),
      outstanding_balance: Number(this.outstandingBalance(loan)),
      carried_forward_amount: Number(loan.carried_forward_amount),
      installment_amount: Number(loan.installment_amount),
      installment_count: loan.installment_count,
      installment_schedule: scheduleAsNumbers(loan.installment_schedule, money(loan.installment_amount)),
      disbursement_date: dateOnly(loan.disbursement_date),
      start_period_start: dateOnly(loan.start_period_start),
      next_collection_period_start: dateOnly(nextCollectionCycle(loan.start_period_start, loan.transactions)),
      next_due_amount: loan.status === LoanStatus.ACTIVE ? Number(this.cycleDue(loan)) : 0,
      status: loan.status,
    };
  }

  private serializeLoan(loan: employee_loans & {
    transactions: {
      id: number;
      type: LoanTransactionType;
      payroll_run_line_id: number | null;
      due_amount: Prisma.Decimal;
      amount: Prisma.Decimal;
      balance_after: Prisma.Decimal;
      reason: string | null;
      created_by: string;
      created_at: Date;
      payroll_run_line: {
        id: number;
        payroll_runs: { period_start: Date; period_end: Date };
      } | null;
    }[];
  }, isCurrent: boolean) {
    const total = Number(loan.total_amount);
    const cycles = coveredCycles(loan.start_period_start, loan.transactions);
    const lastTxn = [...loan.transactions].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id - b.id,
    ).at(-1);
    return {
      id: loan.id,
      employee_id: loan.employee_id,
      total_amount: total,
      amount_repaid_opening: Number(loan.amount_repaid_opening),
      installment_count: loan.installment_count,
      installment_amount: Number(loan.installment_amount),
      installment_schedule: scheduleAsNumbers(loan.installment_schedule, money(loan.installment_amount)),
      disbursement_date: dateOnly(loan.disbursement_date),
      start_period_start: dateOnly(loan.start_period_start),
      next_collection_period_start: dateOnly(nextCollectionCycle(loan.start_period_start, loan.transactions)),
      next_due_amount: loan.status === LoanStatus.ACTIVE ? Number(this.cycleDue(loan)) : 0,
      recovered_amount: Number(loan.recovered_amount),
      lump_sum_repaid_amount: Number(loan.lump_sum_repaid_amount),
      written_off_amount: Number(loan.written_off_amount),
      carried_forward_amount: Number(loan.carried_forward_amount),
      outstanding_balance: Number(this.outstandingBalance(loan)),
      status: loan.status,
      notes: loan.notes,
      created_by: loan.created_by,
      created_at: loan.created_at.toISOString(),
      updated_at: loan.updated_at.toISOString(),
      transactions: loan.transactions.map((txn) => ({
        id: txn.id,
        type: txn.type,
        payroll_run_line_id: txn.payroll_run_line_id,
        due_amount: Number(txn.due_amount),
        amount: Number(txn.amount),
        balance_after: Number(txn.balance_after),
        reason: txn.reason,
        created_by: txn.created_by,
        created_at: txn.created_at.toISOString(),
        period_start: txn.payroll_run_line
          ? dateOnly(txn.payroll_run_line.payroll_runs.period_start)
          : cycles.has(txn) ? dateOnly(cycles.get(txn)!) : null,
        period_end: txn.payroll_run_line
          ? dateOnly(txn.payroll_run_line.payroll_runs.period_end)
          : cycles.has(txn) ? dateOnly(cycleEnd(cycles.get(txn)!)) : null,
        /** TAFSD-589: taken outside payroll and recorded by hand. */
        recorded_manually: txn.type === LoanTransactionType.DEDUCTION && !txn.payroll_run_line_id,
        /** The latest entry on the current loan, recorded outside payroll. The server still refuses once a payroll for that cycle or later is finalized. */
        can_undo: isCurrent && txn === lastTxn && txn.type === LoanTransactionType.DEDUCTION && !txn.payroll_run_line_id,
      })),
    };
  }
}
