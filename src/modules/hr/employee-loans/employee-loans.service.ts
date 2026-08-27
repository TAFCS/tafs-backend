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
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { auditActorLabel } from '../../../common/utils/audit-actor.util';
import { computePayrollWindow, currentPayrollPeriodLabel, parsePayrollPeriod } from '../payroll/payroll-period.util';
import { SecurityDepositsService } from '../security-deposits/security-deposits.service';
import {
  assertScheduleMatchesRemaining,
  buildEqualSchedule,
  money,
  nextScheduledAmount,
  scheduleAsNumbers,
  scheduleJson,
  shiftScheduleAfterCollection,
} from '../installment-schedule.util';
import { CreateLoanDto, LumpSumRepaymentDto, UpdateInstallmentScheduleDto, WriteOffLoanDto } from './dto/employee-loans.dto';

const ZERO = new Prisma.Decimal(0);
const OPEN_STATUSES: LoanStatus[] = [LoanStatus.ACTIVE, LoanStatus.OUTSTANDING];
const OFFBOARDED_STATUSES: EmployeeStatus[] = [EmployeeStatus.LEFT, EmployeeStatus.TERMINATED];

type Tx = Prisma.TransactionClient;

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function currentCycleStart(): Date {
  const { year, month } = parsePayrollPeriod(currentPayrollPeriodLabel());
  return computePayrollWindow(year, month).periodStart;
}

@Injectable()
export class EmployeeLoansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly securityDeposits: SecurityDepositsService,
  ) {}

  async getForEmployee(employeeId: number) {
    await this.assertEmployee(employeeId);
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
      current: current ? this.serializeLoan(current) : null,
      history: history.map((l) => this.serializeLoan(l)),
      default_start_period_start: dateOnly(currentCycleStart()),
    };
  }

  async listOpen(user: IJwtStaffPayload, status?: LoanStatus) {
    const statuses = status ? [status] : OPEN_STATUSES;
    const where: Prisma.employee_loansWhereInput = {
      status: { in: statuses },
    };
    if (user.campusId != null) {
      where.employee_profiles = { campus_id: user.campusId };
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
      },
      orderBy: [{ status: 'asc' }, { start_period_start: 'desc' }, { id: 'desc' }],
    });
    return loans.map((loan) => this.serializeListRow(loan));
  }

  async create(employeeId: number, dto: CreateLoanDto, user: IJwtStaffPayload) {
    await this.assertEmployee(employeeId);
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
    const schedule = buildEqualSchedule(remaining, dto.installment_count);
    if (schedule.length === 0) {
      throw new BadRequestException('Installment amount must be greater than zero. Increase the total or reduce the number of months.');
    }
    const disbursedAt = dto.disbursement_date
      ? new Date(`${dto.disbursement_date.slice(0, 10)}T00:00:00.000Z`)
      : new Date(`${dateOnly(new Date())}T00:00:00.000Z`);
    const start = dto.start_period_start
      ? new Date(`${dto.start_period_start.slice(0, 10)}T00:00:00.000Z`)
      : currentCycleStart();

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

  async updateSchedule(employeeId: number, dto: UpdateInstallmentScheduleDto, user: IJwtStaffPayload) {
    await this.prisma.$transaction(async (tx) => {
      await this.assertEmployee(employeeId, tx);
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
    const amount = money(dto.amount);
    await this.prisma.$transaction(async (tx) => {
      const loan = await this.requireOpenLoan(employeeId, tx);
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
    const amount = money(dto.amount);
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException('A reason is required to write off a loan.');
    }

    await this.prisma.$transaction(async (tx) => {
      const loan = await this.requireOpenLoan(employeeId, tx);
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
    await this.prisma.$transaction(async (tx) => {
      const loan = await this.requireOpenLoan(employeeId, tx);
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
    await this.prisma.$transaction(async (tx) => {
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
      .plus(line.break_deduction)
      .plus(line.eobi_deduction)
      .plus(line.income_tax_deduction)
      .plus(line.sandwich_deduction)
      .plus(line.consecutive_late_deduction);

    const monthly = money(line.monthly_pay);
    const available = Prisma.Decimal.max(ZERO, monthly.minus(base));

    const loan = await this.findCollectingLoan(employeeId, tx);
    let collected = ZERO;
    if (loan && line.payroll_runs.period_start >= loan.start_period_start) {
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

    const loan = await this.findCollectingLoan(line.employee_id, tx);
    if (!loan) return;
    if (line.payroll_runs.period_start < loan.start_period_start) return;

    const due = this.cycleDue(loan);
    const amount = money(line.loan_deduction);
    if (due.lte(0) && amount.lte(0)) return;

    const existing = await tx.employee_loan_transactions.findFirst({
      where: {
        loan_id: loan.id,
        payroll_run_line_id: line.id,
        type: LoanTransactionType.DEDUCTION,
      },
    });
    if (existing) return;

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
          payroll_run_line_id: line.id,
          due_amount: due,
          amount,
          balance_after: balanceAfter,
          created_by: createdBy,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
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

  private async requireOpenLoan(employeeId: number, tx: Tx): Promise<employee_loans> {
    await this.assertEmployee(employeeId, tx);
    const loan = await tx.employee_loans.findFirst({
      where: { employee_id: employeeId, status: { in: OPEN_STATUSES } },
    });
    if (!loan) {
      throw new NotFoundException('No open loan for this employee.');
    }
    return loan;
  }

  private async assertEmployee(employeeId: number, tx: Tx = this.prisma) {
    const employee = await tx.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException(`Employee ${employeeId} not found`);
  }

  private serializeListRow(loan: employee_loans & {
    employee_profiles: {
      id: number;
      full_name: string | null;
      employee_code: string | null;
      campuses: { campus_name: string } | null;
    };
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
  }) {
    const total = Number(loan.total_amount);
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
        period_start: txn.payroll_run_line ? dateOnly(txn.payroll_run_line.payroll_runs.period_start) : null,
        period_end: txn.payroll_run_line ? dateOnly(txn.payroll_run_line.payroll_runs.period_end) : null,
      })),
    };
  }
}
