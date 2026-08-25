import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  SecurityDepositStatus,
  SecurityDepositTransactionType,
  employee_security_deposits,
} from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { auditActorLabel } from '../../../common/utils/audit-actor.util';
import { computePayrollWindow, currentPayrollPeriodLabel, parsePayrollPeriod } from '../payroll/payroll-period.util';
import { CreateSecurityDepositDto, ForfeitSecurityDepositDto, RefundSecurityDepositDto } from './dto/security-deposits.dto';

const ZERO = new Prisma.Decimal(0);
const OPEN_STATUSES: SecurityDepositStatus[] = [SecurityDepositStatus.ACTIVE, SecurityDepositStatus.COMPLETED];

type Tx = Prisma.TransactionClient;

function money(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2);
}

function installmentAmount(total: Prisma.Decimal, count: number): Prisma.Decimal {
  const cents = total.times(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN);
  return cents.dividedToIntegerBy(count).dividedBy(100).toDecimalPlaces(2);
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function currentCycleStart(): Date {
  const { year, month } = parsePayrollPeriod(currentPayrollPeriodLabel());
  return computePayrollWindow(year, month).periodStart;
}

@Injectable()
export class SecurityDepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async getForEmployee(employeeId: number) {
    await this.assertEmployee(employeeId);
    const plans = await this.prisma.employee_security_deposits.findMany({
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
    const current = plans.find((p) => OPEN_STATUSES.includes(p.status)) ?? null;
    const history = plans.filter((p) => p.id !== current?.id);
    return {
      current: current ? this.serializePlan(current) : null,
      history: history.map((p) => this.serializePlan(p)),
      default_start_period_start: dateOnly(currentCycleStart()),
    };
  }

  async listOpen(user: IJwtStaffPayload, status?: SecurityDepositStatus) {
    const statuses = status ? [status] : OPEN_STATUSES;
    const where: Prisma.employee_security_depositsWhereInput = {
      status: { in: statuses },
    };
    if (user.campusId != null) {
      where.employee_profiles = { campus_id: user.campusId };
    }

    const plans = await this.prisma.employee_security_deposits.findMany({
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
    return plans.map((plan) => this.serializeListRow(plan));
  }

  async create(employeeId: number, dto: CreateSecurityDepositDto, user: IJwtStaffPayload) {
    await this.assertEmployee(employeeId);
    const open = await this.prisma.employee_security_deposits.findFirst({
      where: { employee_id: employeeId, status: { in: OPEN_STATUSES } },
    });
    if (open) {
      throw new ConflictException('This employee already has an active security deposit plan.');
    }

    const total = money(dto.total_amount);
    const installment = installmentAmount(total, dto.installment_count);
    if (installment.lte(0)) {
      throw new BadRequestException('Installment amount must be greater than zero. Increase the total or reduce the number of months.');
    }
    const start = dto.start_period_start
      ? new Date(`${dto.start_period_start.slice(0, 10)}T00:00:00.000Z`)
      : currentCycleStart();

    await this.prisma.$transaction(async (tx) => {
      try {
        await tx.employee_security_deposits.create({
          data: {
            employee_id: employeeId,
            total_amount: total,
            installment_count: dto.installment_count,
            installment_amount: installment,
            start_period_start: start,
            notes: dto.notes?.trim() || null,
            created_by: user.sub,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException('This employee already has an active security deposit plan.');
        }
        throw err;
      }
      await this.recapOpenDraftLines(employeeId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'SECURITY_DEPOSIT_CREATED',
      changed_by: auditActorLabel(user),
      note: `Started security deposit of ${total.toFixed(2)} over ${dto.installment_count} month(s), starting ${dateOnly(start)}.`,
    });

    return this.getForEmployee(employeeId);
  }

  async refund(employeeId: number, dto: RefundSecurityDepositDto, user: IJwtStaffPayload) {
    const amount = money(dto.amount);
    await this.prisma.$transaction(async (tx) => {
      const plan = await this.requireOpenPlan(employeeId, tx);
      const held = this.heldAmount(plan);
      if (amount.gt(held)) {
        throw new BadRequestException(`Refund cannot exceed the held balance of ${held.toFixed(2)}.`);
      }
      const refunded = money(plan.refunded_amount).plus(amount);
      const heldAfter = money(plan.recovered_amount).minus(refunded).minus(plan.forfeited_amount);
      const status = this.nextStatus(plan.total_amount, plan.recovered_amount, refunded, plan.forfeited_amount);

      await tx.employee_security_deposit_transactions.create({
        data: {
          deposit_id: plan.id,
          type: SecurityDepositTransactionType.REFUND,
          due_amount: amount,
          amount,
          running_balance: heldAfter.lt(0) ? ZERO : heldAfter,
          reason: dto.notes?.trim() || null,
          created_by: user.sub,
        },
      });
      await tx.employee_security_deposits.update({
        where: { id: plan.id },
        data: { refunded_amount: refunded, status },
      });
      await this.recapOpenDraftLines(employeeId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'SECURITY_DEPOSIT_REFUNDED',
      changed_by: auditActorLabel(user),
      note: `Refunded ${amount.toFixed(2)} of security deposit.${dto.notes ? ` ${dto.notes}` : ''}`,
    });

    return this.getForEmployee(employeeId);
  }

  async forfeit(employeeId: number, dto: ForfeitSecurityDepositDto, user: IJwtStaffPayload) {
    const amount = money(dto.amount);
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException('A reason is required to forfeit a security deposit.');
    }

    await this.prisma.$transaction(async (tx) => {
      const plan = await this.requireOpenPlan(employeeId, tx);
      const held = this.heldAmount(plan);
      if (amount.gt(held)) {
        throw new BadRequestException(`Forfeit cannot exceed the held balance of ${held.toFixed(2)}.`);
      }
      const forfeited = money(plan.forfeited_amount).plus(amount);
      const heldAfter = money(plan.recovered_amount).minus(plan.refunded_amount).minus(forfeited);
      const status = this.nextStatus(plan.total_amount, plan.recovered_amount, plan.refunded_amount, forfeited);

      await tx.employee_security_deposit_transactions.create({
        data: {
          deposit_id: plan.id,
          type: SecurityDepositTransactionType.FORFEIT,
          due_amount: amount,
          amount,
          running_balance: heldAfter.lt(0) ? ZERO : heldAfter,
          reason,
          created_by: user.sub,
        },
      });
      await tx.employee_security_deposits.update({
        where: { id: plan.id },
        data: { forfeited_amount: forfeited, status },
      });
      await this.recapOpenDraftLines(employeeId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'SECURITY_DEPOSIT_FORFEITED',
      changed_by: auditActorLabel(user),
      note: `Forfeited ${amount.toFixed(2)} of security deposit. ${reason}`,
    });

    return this.getForEmployee(employeeId);
  }

  async cancel(employeeId: number, user: IJwtStaffPayload) {
    await this.prisma.$transaction(async (tx) => {
      const plan = await this.requireOpenPlan(employeeId, tx);
      if (money(plan.recovered_amount).gt(0)) {
        throw new BadRequestException('Cannot cancel a plan after payroll has recovered any amount. Refund or forfeit the held balance instead.');
      }
      await tx.employee_security_deposits.delete({ where: { id: plan.id } });
      await this.recapOpenDraftLines(employeeId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'SECURITY_DEPOSIT_CANCELLED',
      changed_by: auditActorLabel(user),
      note: 'Cancelled unused security deposit plan.',
    });

    return this.getForEmployee(employeeId);
  }

  /**
   * Snapshot the cycle's deposit deduction onto a payroll line after attendance,
   * statutory, and applied-flag amounts are already stored. Caps at remaining
   * net so discretionary installments never push pay below zero. Loans are
   * applied first ù `EmployeeLoansService.applySnapshotToLine` must have run
   * (and written `loan_deduction`) before this, which is why every caller
   * (PayrollService, and the loans service's own recap) always calls the loan
   * pass immediately before this one.
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
    const loanCollected = money(line.loan_deduction);
    const remainingForDeposit = Prisma.Decimal.max(ZERO, available.minus(loanCollected));

    const plan = await this.findCollectingPlan(employeeId, tx);
    let collected = ZERO;
    if (plan && line.payroll_runs.period_start >= plan.start_period_start) {
      const due = this.cycleDue(plan);
      collected = Prisma.Decimal.min(due, remainingForDeposit).toDecimalPlaces(2);
    }

    const totalDeductions = base.plus(loanCollected).plus(collected).toDecimalPlaces(2);
    const netPay = monthly.minus(totalDeductions).toDecimalPlaces(2);

    await tx.payroll_run_lines.update({
      where: { id: line.id },
      data: {
        security_deposit_deduction: collected,
        total_deductions: totalDeductions,
        net_pay: netPay,
      },
    });
  }

  /** Persist a DEDUCTION ledger row when a non-test line is finalized. Idempotent per plan/line. */
  async commitLineDeduction(lineId: number, createdBy: string, tx: Tx = this.prisma): Promise<void> {
    const line = await tx.payroll_run_lines.findUnique({
      where: { id: lineId },
      include: { payroll_runs: { select: { period_start: true, is_test: true } } },
    });
    if (!line || line.payroll_runs.is_test) return;

    const plan = await this.findCollectingPlan(line.employee_id, tx);
    if (!plan) return;
    if (line.payroll_runs.period_start < plan.start_period_start) return;

    const due = this.cycleDue(plan);
    const amount = money(line.security_deposit_deduction);
    if (due.lte(0) && amount.lte(0)) return;

    const existing = await tx.employee_security_deposit_transactions.findFirst({
      where: {
        deposit_id: plan.id,
        payroll_run_line_id: line.id,
        type: SecurityDepositTransactionType.DEDUCTION,
      },
    });
    if (existing) return;

    const recovered = money(plan.recovered_amount).plus(amount);
    const heldAfter = recovered.minus(plan.refunded_amount).minus(plan.forfeited_amount);
    const carry = recovered.gte(plan.total_amount)
      ? ZERO
      : Prisma.Decimal.max(ZERO, due.minus(amount)).toDecimalPlaces(2);
    const status = this.nextStatus(plan.total_amount, recovered, plan.refunded_amount, plan.forfeited_amount);

    try {
      await tx.employee_security_deposit_transactions.create({
        data: {
          deposit_id: plan.id,
          type: SecurityDepositTransactionType.DEDUCTION,
          payroll_run_line_id: line.id,
          due_amount: due,
          amount,
          running_balance: heldAfter.lt(0) ? ZERO : heldAfter,
          created_by: createdBy,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }

    await tx.employee_security_deposits.update({
      where: { id: plan.id },
      data: {
        recovered_amount: recovered,
        carried_forward_amount: carry,
        status,
      },
    });
  }

  private async recapOpenDraftLines(employeeId: number, tx: Tx): Promise<void> {
    const lines = await tx.payroll_run_lines.findMany({
      where: { employee_id: employeeId, finalized_at: null },
      select: { payroll_run_id: true },
    });
    for (const line of lines) {
      await this.applySnapshotToLine(line.payroll_run_id, employeeId, tx);
    }
  }

  private cycleDue(plan: employee_security_deposits): Prisma.Decimal {
    const remaining = money(plan.total_amount).minus(plan.recovered_amount);
    if (remaining.lte(0)) return ZERO;
    return Prisma.Decimal.min(
      money(plan.installment_amount).plus(plan.carried_forward_amount),
      remaining,
    ).toDecimalPlaces(2);
  }

  private heldAmount(plan: employee_security_deposits): Prisma.Decimal {
    const held = money(plan.recovered_amount).minus(plan.refunded_amount).minus(plan.forfeited_amount);
    return held.lt(0) ? ZERO : held;
  }

  /** Close only after the target is fully recovered and nothing remains held. */
  private nextStatus(
    total: Prisma.Decimal | number | string,
    recovered: Prisma.Decimal | number | string,
    refunded: Prisma.Decimal | number | string,
    forfeited: Prisma.Decimal | number | string,
  ): SecurityDepositStatus {
    if (money(recovered).lt(total)) return SecurityDepositStatus.ACTIVE;
    const held = money(recovered).minus(refunded).minus(forfeited);
    if (held.gt(0)) return SecurityDepositStatus.COMPLETED;
    return this.closedStatus(refunded, forfeited);
  }

  private closedStatus(refunded: Prisma.Decimal | number | string, forfeited: Prisma.Decimal | number | string): SecurityDepositStatus {
    const hasRefund = money(refunded).gt(0);
    const hasForfeit = money(forfeited).gt(0);
    if (hasRefund && hasForfeit) return SecurityDepositStatus.PARTIALLY_FORFEITED;
    if (hasForfeit) return SecurityDepositStatus.FORFEITED;
    return SecurityDepositStatus.REFUNDED;
  }

  private async findCollectingPlan(employeeId: number, tx: Tx): Promise<employee_security_deposits | null> {
    return tx.employee_security_deposits.findFirst({
      where: { employee_id: employeeId, status: SecurityDepositStatus.ACTIVE },
    });
  }

  private async requireOpenPlan(employeeId: number, tx: Tx): Promise<employee_security_deposits> {
    await this.assertEmployee(employeeId, tx);
    const plan = await tx.employee_security_deposits.findFirst({
      where: { employee_id: employeeId, status: { in: OPEN_STATUSES } },
    });
    if (!plan) {
      throw new NotFoundException('No open security deposit plan for this employee.');
    }
    return plan;
  }

  private async assertEmployee(employeeId: number, tx: Tx = this.prisma) {
    const employee = await tx.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException(`Employee ${employeeId} not found`);
  }

  private serializeListRow(plan: employee_security_deposits & {
    employee_profiles: {
      id: number;
      full_name: string | null;
      employee_code: string | null;
      campuses: { campus_name: string } | null;
    };
  }) {
    const recovered = Number(plan.recovered_amount);
    const refunded = Number(plan.refunded_amount);
    const forfeited = Number(plan.forfeited_amount);
    const total = Number(plan.total_amount);
    return {
      id: plan.id,
      employee_id: plan.employee_id,
      full_name: plan.employee_profiles.full_name,
      employee_code: plan.employee_profiles.employee_code,
      campus_name: plan.employee_profiles.campuses?.campus_name ?? null,
      total_amount: total,
      recovered_amount: recovered,
      held_amount: Math.max(0, recovered - refunded - forfeited),
      remaining_to_collect: Math.max(0, total - recovered),
      carried_forward_amount: Number(plan.carried_forward_amount),
      installment_amount: Number(plan.installment_amount),
      installment_count: plan.installment_count,
      start_period_start: dateOnly(plan.start_period_start),
      status: plan.status,
    };
  }

  private serializePlan(plan: employee_security_deposits & {
    transactions: {
      id: number;
      type: SecurityDepositTransactionType;
      payroll_run_line_id: number | null;
      due_amount: Prisma.Decimal;
      amount: Prisma.Decimal;
      running_balance: Prisma.Decimal;
      reason: string | null;
      created_by: string;
      created_at: Date;
      payroll_run_line: {
        id: number;
        payroll_runs: { period_start: Date; period_end: Date };
      } | null;
    }[];
  }) {
    const recovered = Number(plan.recovered_amount);
    const refunded = Number(plan.refunded_amount);
    const forfeited = Number(plan.forfeited_amount);
    const total = Number(plan.total_amount);
    const held = Math.max(0, recovered - refunded - forfeited);
    return {
      id: plan.id,
      employee_id: plan.employee_id,
      total_amount: total,
      installment_count: plan.installment_count,
      installment_amount: Number(plan.installment_amount),
      start_period_start: dateOnly(plan.start_period_start),
      recovered_amount: recovered,
      refunded_amount: refunded,
      forfeited_amount: forfeited,
      carried_forward_amount: Number(plan.carried_forward_amount),
      held_amount: held,
      remaining_to_collect: Math.max(0, total - recovered),
      status: plan.status,
      notes: plan.notes,
      created_by: plan.created_by,
      created_at: plan.created_at.toISOString(),
      updated_at: plan.updated_at.toISOString(),
      transactions: plan.transactions.map((txn) => ({
        id: txn.id,
        type: txn.type,
        payroll_run_line_id: txn.payroll_run_line_id,
        due_amount: Number(txn.due_amount),
        amount: Number(txn.amount),
        running_balance: Number(txn.running_balance),
        reason: txn.reason,
        created_by: txn.created_by,
        created_at: txn.created_at.toISOString(),
        period_start: txn.payroll_run_line ? dateOnly(txn.payroll_run_line.payroll_runs.period_start) : null,
        period_end: txn.payroll_run_line ? dateOnly(txn.payroll_run_line.payroll_runs.period_end) : null,
      })),
    };
  }
}
