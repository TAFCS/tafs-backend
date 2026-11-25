import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  SecurityDepositStatus,
  SecurityDepositTransactionType,
  employee_security_deposits,
} from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { ScopeService } from '../../../common/scope/scope.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { auditActorLabel } from '../../../common/utils/audit-actor.util';
import { computePayrollWindow, currentPayrollPeriodLabel, parsePayrollPeriod } from '../payroll/payroll-period.util';
import {
  assertScheduleMatchesRemaining,
  buildCreateSchedule,
  money,
  nextScheduledAmount,
  parseInstallmentSchedule,
  restoreScheduleBeforeCollection,
  scheduleAsNumbers,
  scheduleJson,
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
import {
  BulkMarkInstallmentsCollectedDto,
  ClosePlanDto,
  CreateSecurityDepositDto,
  ForfeitSecurityDepositDto,
  MarkInstallmentCollectedDto,
  RefundSecurityDepositDto,
  UpdateDepositInstallmentScheduleDto,
} from './dto/security-deposits.dto';
import { assertMayChangeEmployee } from '../../../common/auth/super-admin';

const ZERO = new Prisma.Decimal(0);
const OPEN_STATUSES: SecurityDepositStatus[] = [SecurityDepositStatus.ACTIVE, SecurityDepositStatus.COMPLETED];

type Tx = Prisma.TransactionClient;

function currentCycleStart(): Date {
  const { year, month } = parsePayrollPeriod(currentPayrollPeriodLabel());
  return computePayrollWindow(year, month).periodStart;
}

export { coveredCycles };
export type { CycleTxn };

/** Snaps any date to the start of the 26th-25th cycle that contains it. */
function snapToCycleStart(date: Date): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  return date.getUTCDate() >= 26 ? new Date(Date.UTC(y, m, 26)) : new Date(Date.UTC(y, m - 1, 26));
}

function shiftCycleStart(periodStart: Date, months: number): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + months, 26));
}

const NOTES_MAX = 500;
function appendNote(existing: string | null, addition: string): string {
  return [existing, addition].filter(Boolean).join(' | ').slice(0, NOTES_MAX);
}

@Injectable()
export class SecurityDepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly scope: ScopeService,
  ) {}

  async getForEmployee(employeeId: number, user?: IJwtStaffPayload) {
    await this.assertEmployee(employeeId, user);
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
      current: current ? this.serializePlan(current, true) : null,
      history: history.map((p) => this.serializePlan(p, false)),
      default_start_period_start: dateOnly(await this.defaultStartFor(employeeId)),
    };
  }

  /**
   * Earliest cycle a new plan may start in. The cycle that just ended stays
   * open until this employee's real payroll for it is finalized, so a plan
   * recorded on the 27th can still be taken from that month's salary
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

  async listOpen(user: IJwtStaffPayload, status?: SecurityDepositStatus) {
    const statuses = status ? [status] : OPEN_STATUSES;
    const where: Prisma.employee_security_depositsWhereInput = {
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
        transactions: {
          where: { type: SecurityDepositTransactionType.DEDUCTION },
          select: {
            id: true,
            type: true,
            created_at: true,
            payroll_run_line: { select: { payroll_runs: { select: { period_start: true } } } },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { start_period_start: 'desc' }, { id: 'desc' }],
    });
    return plans.map((plan) => this.serializeListRow(plan));
  }

  async create(employeeId: number, dto: CreateSecurityDepositDto, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'security deposit');
    await this.assertEmployee(employeeId, user);
    const profile = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { employment_status: true, monthly_pay: true, payroll_enabled: true },
    });
    if (profile && (profile.employment_status === 'LEFT' || profile.employment_status === 'TERMINATED')) {
      throw new BadRequestException('This employee has left — a new security deposit plan cannot be started for them.');
    }
    const open = await this.prisma.employee_security_deposits.findFirst({
      where: { employee_id: employeeId, status: { in: OPEN_STATUSES } },
    });
    if (open) {
      throw new ConflictException('This employee already has an active security deposit plan.');
    }

    const total = money(dto.total_amount);
    const schedule = buildCreateSchedule(total, dto.installment_count, dto.installment_amounts);
    if (schedule.length === 0) {
      throw new BadRequestException('Installment amount must be greater than zero. Increase the total or reduce the number of months.');
    }
    const start = dto.start_period_start
      ? snapToCycleStart(new Date(`${dto.start_period_start.slice(0, 10)}T00:00:00.000Z`))
      : await this.defaultStartFor(employeeId);
    const thisCycle = currentCycleStart();
    if (start < shiftCycleStart(thisCycle, -12) || start > shiftCycleStart(thisCycle, 12)) {
      throw new BadRequestException('Start cycle must be within a year of the current payroll cycle.');
    }

    const warnings: string[] = [];
    const monthlyPay = profile?.monthly_pay ? money(profile.monthly_pay) : ZERO;
    if (profile && (!profile.payroll_enabled || monthlyPay.lte(0))) {
      warnings.push('This employee has no monthly pay or is not on payroll, so nothing will be collected until that is set.');
    } else if (monthlyPay.gt(0) && money(Math.max(...schedule)).gt(monthlyPay)) {
      warnings.push(
        `An installment of ${money(Math.max(...schedule)).toFixed(2)} is more than the monthly pay of ${monthlyPay.toFixed(2)}; each cycle will collect only what pay allows and the rest carries forward.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      try {
        await tx.employee_security_deposits.create({
          data: {
            employee_id: employeeId,
            total_amount: total,
            installment_count: schedule.length,
            installment_amount: money(schedule[0]),
            installment_schedule: scheduleJson(schedule),
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
      note: `Started security deposit of ${total.toFixed(2)} over ${schedule.length} month(s), starting ${dateOnly(start)}.`,
    });

    return { ...(await this.getForEmployee(employeeId)), warnings };
  }

  async updateSchedule(employeeId: number, dto: UpdateDepositInstallmentScheduleDto, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'security deposit');
    await this.prisma.$transaction(async (tx) => {
      await this.assertEmployee(employeeId, user, tx);
      await this.lockEmployeePlans(employeeId, tx);
      const plan = await tx.employee_security_deposits.findFirst({
        where: { employee_id: employeeId, status: SecurityDepositStatus.ACTIVE },
      });
      if (!plan) {
        throw new NotFoundException('No collecting security deposit plan for this employee.');
      }
      const remaining = money(plan.total_amount).minus(plan.recovered_amount);
      if (remaining.lte(0)) {
        throw new BadRequestException('There is nothing left to collect on this plan.');
      }
      const schedule = assertScheduleMatchesRemaining(dto.installment_amounts, remaining);
      await tx.employee_security_deposits.update({
        where: { id: plan.id },
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
      action: 'SECURITY_DEPOSIT_SCHEDULE_UPDATED',
      changed_by: auditActorLabel(user),
      note: `Updated remaining recovery to ${dto.installment_amounts.length} month(s).`,
    });

    return this.getForEmployee(employeeId);
  }

  async refund(employeeId: number, dto: RefundSecurityDepositDto, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'security deposit');
    const amount = money(dto.amount);
    await this.prisma.$transaction(async (tx) => {
      const plan = await this.requireOpenPlan(employeeId, user, tx);
      const held = this.heldAmount(plan);
      if (amount.gt(held)) {
        throw new BadRequestException(`Refund cannot exceed the held balance of ${held.toFixed(2)}.`);
      }
      const refunded = money(plan.refunded_amount).plus(amount);
      const heldAfter = money(plan.recovered_amount).minus(refunded).minus(plan.forfeited_amount);
      const stop = (await this.wantsStopCollection(dto.stop_collection, employeeId, tx)) ? this.stopCollectionFields(plan) : null;
      const status = this.nextStatus(stop?.total_amount ?? plan.total_amount, plan.recovered_amount, refunded, plan.forfeited_amount);

      await tx.employee_security_deposit_transactions.create({
        data: {
          deposit_id: plan.id,
          type: SecurityDepositTransactionType.REFUND,
          due_amount: amount,
          amount,
          running_balance: heldAfter.lt(0) ? ZERO : heldAfter,
          reason: [dto.notes?.trim(), stop?.note].filter(Boolean).join(' — ').slice(0, NOTES_MAX) || null,
          created_by: user.sub,
        },
      });
      await tx.employee_security_deposits.update({
        where: { id: plan.id },
        data: { refunded_amount: refunded, status, ...(stop?.data ?? {}) },
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
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'security deposit');
    const amount = money(dto.amount);
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException('A reason is required to forfeit a security deposit.');
    }

    await this.prisma.$transaction(async (tx) => {
      const plan = await this.requireOpenPlan(employeeId, user, tx);
      const held = this.heldAmount(plan);
      if (amount.gt(held)) {
        throw new BadRequestException(`Forfeit cannot exceed the held balance of ${held.toFixed(2)}.`);
      }
      const forfeited = money(plan.forfeited_amount).plus(amount);
      const heldAfter = money(plan.recovered_amount).minus(plan.refunded_amount).minus(forfeited);
      const stop = (await this.wantsStopCollection(dto.stop_collection, employeeId, tx)) ? this.stopCollectionFields(plan) : null;
      const status = this.nextStatus(stop?.total_amount ?? plan.total_amount, plan.recovered_amount, plan.refunded_amount, forfeited);

      await tx.employee_security_deposit_transactions.create({
        data: {
          deposit_id: plan.id,
          type: SecurityDepositTransactionType.FORFEIT,
          due_amount: amount,
          amount,
          running_balance: heldAfter.lt(0) ? ZERO : heldAfter,
          reason: (stop?.note ? `${reason} — ${stop.note}` : reason).slice(0, NOTES_MAX),
          created_by: user.sub,
        },
      });
      await tx.employee_security_deposits.update({
        where: { id: plan.id },
        data: { forfeited_amount: forfeited, status, ...(stop?.data ?? {}) },
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

  /**
   * Stops collecting the rest of an unfinished plan (employee left, or the
   * remaining balance is being written off). The target drops to what was
   * actually recovered, so payroll stops deducting and a new plan can be
   * started. Whatever is held is still refunded or forfeited separately.
   */
  async closePlan(employeeId: number, dto: ClosePlanDto, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'security deposit');
    let uncollected = ZERO;
    await this.prisma.$transaction(async (tx) => {
      const plan = await this.requireOpenPlan(employeeId, user, tx);
      uncollected = Prisma.Decimal.max(ZERO, money(plan.total_amount).minus(plan.recovered_amount));
      if (uncollected.lte(0)) {
        throw new BadRequestException('Nothing is left to collect on this plan.');
      }
      if (money(plan.recovered_amount).lte(0)) {
        throw new BadRequestException('Nothing has been recovered yet — use Cancel plan instead.');
      }
      const stop = this.stopCollectionFields(plan);
      const status = this.nextStatus(stop.total_amount, plan.recovered_amount, plan.refunded_amount, plan.forfeited_amount);
      await tx.employee_security_deposits.update({
        where: { id: plan.id },
        data: {
          ...stop.data,
          status,
          notes: appendNote(plan.notes, `${stop.note}${dto.notes?.trim() ? ` ${dto.notes.trim()}` : ''}`),
        },
      });
      await this.recapOpenDraftLines(employeeId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'SECURITY_DEPOSIT_COLLECTION_STOPPED',
      changed_by: auditActorLabel(user),
      note: `Stopped collecting security deposit; ${uncollected.toFixed(2)} will not be collected.${dto.notes ? ` ${dto.notes}` : ''}`,
    });

    return this.getForEmployee(employeeId);
  }

  /** Explicit choice wins; otherwise an employee who has already left is never charged the rest of the plan. */
  private async wantsStopCollection(explicit: boolean | undefined, employeeId: number, tx: Tx): Promise<boolean> {
    if (explicit !== undefined) return explicit;
    const profile = await tx.employee_profiles.findUnique({ where: { id: employeeId }, select: { employment_status: true } });
    return profile?.employment_status === 'LEFT' || profile?.employment_status === 'TERMINATED';
  }

  /** Target drops to the amount already recovered and the remaining queue is cleared. */
  private stopCollectionFields(plan: employee_security_deposits) {
    const uncollected = Prisma.Decimal.max(ZERO, money(plan.total_amount).minus(plan.recovered_amount));
    return {
      total_amount: money(plan.recovered_amount),
      note: uncollected.gt(0)
        ? `Collection stopped on ${dateOnly(new Date())}; ${uncollected.toFixed(2)} of the ${money(plan.total_amount).toFixed(2)} target was not collected.`
        : '',
      data: {
        total_amount: money(plan.recovered_amount),
        carried_forward_amount: ZERO,
        installment_schedule: scheduleJson([]),
        installment_count: 0,
        installment_amount: ZERO,
      },
    };
  }

  async cancel(employeeId: number, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'security deposit');
    await this.prisma.$transaction(async (tx) => {
      const plan = await this.requireOpenPlan(employeeId, user, tx);
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
   * applied first � `EmployeeLoansService.applySnapshotToLine` must have run
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
      .plus(line.early_leave_deduction)
      .plus(line.break_deduction)
      .plus(line.eobi_deduction)
      .plus(line.income_tax_deduction)
      .plus(line.sandwich_deduction)
      .plus(line.after_leaving_deduction)
      .plus(line.consecutive_late_deduction);

    const monthly = money(line.monthly_pay);
    const available = Prisma.Decimal.max(ZERO, monthly.minus(base));
    const loanCollected = money(line.loan_deduction);
    const remainingForDeposit = Prisma.Decimal.max(ZERO, available.minus(loanCollected));

    const plan = await this.findCollectingPlan(employeeId, tx);
    let collected = ZERO;
    if (
      plan &&
      line.payroll_runs.period_start >= plan.start_period_start &&
      !(await this.collectedOutsidePayroll(plan, line.payroll_runs.period_start, tx))
    ) {
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

    await this.lockEmployeePlans(line.employee_id, tx);
    const plan = await this.findCollectingPlan(line.employee_id, tx);
    if (!plan) return;
    if (line.payroll_runs.period_start < plan.start_period_start) return;
    // TAFSD-589: this cycle's installment was already collected outside
    // payroll. Its slot is used up; taking the next one would charge twice.
    if (await this.collectedOutsidePayroll(plan, line.payroll_runs.period_start, tx)) return;

    const due = this.cycleDue(plan);
    const amount = money(line.security_deposit_deduction);
    const remainingNow = money(plan.total_amount).minus(plan.recovered_amount);
    // A 0 due with remaining balance is a skipped cycle — still consume the slot.
    if (due.lte(0) && amount.lte(0) && remainingNow.lte(0)) return;

    const existing = await tx.employee_security_deposit_transactions.findFirst({
      where: {
        deposit_id: plan.id,
        payroll_run_line_id: line.id,
        type: SecurityDepositTransactionType.DEDUCTION,
      },
    });
    if (existing) return;

    const posted = await this.postCollection(plan, due, amount, { payroll_run_line_id: line.id, reason: null, created_by: createdBy }, tx);
    if (!posted) return;

    // Later cycles' drafts were snapshotted before this one collected (or
    // fell short); refresh them so they show the real next installment.
    await this.recapOpenDraftLines(plan.employee_id, tx);
  }

  /**
   * Writes one installment's DEDUCTION and uses up its slot. Payroll and
   * "Mark collected" both go through here, so a slot is consumed the same way
   * whichever took it. Every cycle consumes its slot; a shortfall (less than
   * was due) moves into carry, so schedule + carry always adds up to what is
   * still left and the Edit plan screen opens valid. False on a duplicate.
   */
  private async postCollection(
    plan: employee_security_deposits,
    due: Prisma.Decimal,
    amount: Prisma.Decimal,
    row: { payroll_run_line_id: number | null; reason: string | null; created_by: string },
    tx: Tx,
  ): Promise<boolean> {
    const recovered = money(plan.recovered_amount).plus(amount);
    const heldAfter = recovered.minus(plan.refunded_amount).minus(plan.forfeited_amount);
    const status = this.nextStatus(plan.total_amount, recovered, plan.refunded_amount, plan.forfeited_amount);
    const remainingAfter = money(plan.total_amount).minus(recovered);
    let nextSchedule = parseInstallmentSchedule(plan.installment_schedule, money(plan.installment_amount))
      .slice(1)
      .map((n) => Number(n.toFixed(2)));
    let carry = remainingAfter.lte(0) ? ZERO : Prisma.Decimal.max(ZERO, due.minus(amount)).toDecimalPlaces(2);
    if (remainingAfter.lte(0)) {
      nextSchedule = [];
    } else if (nextSchedule.length === 0) {
      nextSchedule = [Number(remainingAfter.toFixed(2))];
      carry = ZERO;
    }

    try {
      await tx.employee_security_deposit_transactions.create({
        data: {
          deposit_id: plan.id,
          type: SecurityDepositTransactionType.DEDUCTION,
          payroll_run_line_id: row.payroll_run_line_id,
          due_amount: due,
          amount,
          running_balance: heldAfter.lt(0) ? ZERO : heldAfter,
          reason: row.reason ? row.reason.slice(0, NOTES_MAX) : null,
          created_by: row.created_by,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }

    await tx.employee_security_deposits.update({
      where: { id: plan.id },
      data: {
        recovered_amount: recovered,
        carried_forward_amount: carry,
        status,
        installment_schedule: scheduleJson(nextSchedule),
        installment_count: nextSchedule.length,
        installment_amount: money(nextSchedule[0] ?? 0),
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
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'security deposit');
    const result = await this.prisma.$transaction(async (tx) => {
      await this.assertEmployee(employeeId, user, tx);
      return this.collectNextInstallment(employeeId, { amount: dto.amount, notes: dto.notes, periodStart: dto.period_start }, user.sub, tx);
    });
    this.logCollected(employeeId, result, dto.notes, auditActorLabel(user));
    return this.getForEmployee(employeeId);
  }

  /**
   * TAFSD-589: mark one cycle's installment collected for several employees.
   * Each employee is its own transaction: one refusal (the plan's next due
   * cycle is a different one, it was already marked, ...) never blocks the
   * rest, and is reported back. A repeat is refused, never charged twice,
   * because a marked plan's next due cycle moves on.
   */
  async markCollectedBulk(dto: BulkMarkInstallmentsCollectedDto, user: IJwtStaffPayload) {
    const periodStart = parseCycleStart(dto.period_start);
    if (!periodStart) throw new BadRequestException('period_start must be the start of a payroll cycle (the 26th).');
    const results: { employee_id: number; ok: boolean; amount?: number; due_amount?: number; error?: string }[] = [];
    for (const item of dto.items) {
      try {
        await assertMayChangeEmployee(this.prisma, user, item.employee_id, 'security deposit');
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
   * `periodStart`, when given, must be the plan's next due cycle — that is
   * what makes a repeated bulk call refuse rather than take the next slot.
   */
  async collectNextInstallment(
    employeeId: number,
    opts: { amount?: number; notes: string; periodStart?: string },
    createdBy: string,
    tx: Tx,
  ): Promise<{ plan_id: number; period_start: Date; due: Prisma.Decimal; amount: Prisma.Decimal }> {
    const notes = opts.notes.trim();
    if (!notes) throw new BadRequestException('A note is required to mark an installment collected.');
    await this.lockEmployeePlans(employeeId, tx);
    const plan = await this.findCollectingPlan(employeeId, tx);
    if (!plan) throw new NotFoundException('This employee has no security deposit plan collecting installments.');
    if (money(plan.total_amount).minus(plan.recovered_amount).lte(0)) {
      throw new BadRequestException('Nothing is left to collect on this plan.');
    }
    const cycle = nextCollectionCycle(plan.start_period_start, await this.cycleTransactions(plan.id, tx));
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
    const due = this.cycleDue(plan);
    const amount = opts.amount === undefined ? due : money(opts.amount);
    if (amount.lt(0) || amount.gt(due)) {
      throw new BadRequestException(`The amount must be between 0 and the ${due.toFixed(2)} due for ${cycleLabel(cycle)}.`);
    }
    if (due.gt(0) && amount.lte(0)) {
      throw new BadRequestException('Enter the amount collected. To skip a cycle, edit the recovery schedule instead.');
    }
    const what = due.lte(0) ? `${cycleLabel(cycle)} skipped (nothing scheduled)` : `Collected outside payroll for ${cycleLabel(cycle)}`;
    await this.postCollection(plan, due, amount, { payroll_run_line_id: null, reason: `${what}. ${notes}`, created_by: createdBy }, tx);
    await this.recapOpenDraftLines(employeeId, tx);
    return { plan_id: plan.id, period_start: cycle, due, amount };
  }

  /**
   * TAFSD-589: undo an installment recorded outside payroll. Only the plan's
   * latest entry, and only while no payroll for that cycle or a later one has
   * been finalized for the employee: either would have read the balance this
   * entry left behind.
   */
  async undoCollection(employeeId: number, transactionId: number, user: IJwtStaffPayload) {
    await assertMayChangeEmployee(this.prisma, user, employeeId, 'security deposit');
    let undone: { amount: Prisma.Decimal; period_start: Date } | null = null;
    await this.prisma.$transaction(async (tx) => {
      await this.assertEmployee(employeeId, user, tx);
      await this.lockEmployeePlans(employeeId, tx);
      const row = await tx.employee_security_deposit_transactions.findUnique({
        where: { id: transactionId },
        include: { deposit: true },
      });
      if (!row || row.deposit.employee_id !== employeeId) {
        throw new NotFoundException('Installment not found for this employee.');
      }
      if (row.type !== SecurityDepositTransactionType.DEDUCTION || row.payroll_run_line_id !== null) {
        throw new BadRequestException('Only an installment recorded outside payroll can be undone here. A payroll deduction is undone by un-finalizing its payroll line.');
      }
      const cycles = coveredCycles(row.deposit.start_period_start, await this.cycleTransactions(row.deposit_id, tx));
      const cycle = [...cycles.entries()].find(([t]) => t.id === row.id)?.[1] ?? row.deposit.start_period_start;
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
        action: 'SECURITY_DEPOSIT_COLLECTION_UNDONE',
        changed_by: auditActorLabel(user),
        note: `Undid the ${done.amount.toFixed(2)} security deposit installment recorded outside payroll for ${cycleLabel(done.period_start)}. The slot is due again.`,
      });
    }
    return this.getForEmployee(employeeId);
  }

  /**
   * TAFSD-394: undo commitLineDeduction when a payroll line is un-finalized.
   * Removes the line's DEDUCTION row and takes the amount back off the plan.
   * Refuses if anything was posted to the plan after it — a later cycle,
   * refund or forfeit read the balance this deduction left behind.
   */
  async reverseLineDeduction(lineId: number, tx: Tx = this.prisma): Promise<void> {
    const rows = await tx.employee_security_deposit_transactions.findMany({
      where: { payroll_run_line_id: lineId, type: SecurityDepositTransactionType.DEDUCTION },
    });
    for (const row of rows) {
      await this.reverseDeductionRow(row, tx, 'unfinalize');
    }
  }

  private async reverseDeductionRow(
    row: { id: number; deposit_id: number; amount: Prisma.Decimal; due_amount: Prisma.Decimal },
    tx: Tx,
    context: 'unfinalize' | 'undo',
  ): Promise<void> {
    const what = context === 'unfinalize' ? 'This line cannot be un-finalized' : "This installment can't be undone";
    const plan = await tx.employee_security_deposits.findUniqueOrThrow({ where: { id: row.deposit_id } });
    await this.lockEmployeePlans(plan.employee_id, tx);
    const newer = await tx.employee_security_deposits.count({ where: { employee_id: plan.employee_id, id: { gt: plan.id } } });
    if (newer > 0) {
      throw new BadRequestException(`${what}: a newer security deposit plan was opened for this employee after this installment.`);
    }
    const later = await tx.employee_security_deposit_transactions.count({ where: { deposit_id: row.deposit_id, id: { gt: row.id } } });
    if (later > 0) {
      throw new BadRequestException(
        `${what}: the plan has later entries (a later installment, refund or forfeit). Undo those first.`,
      );
    }
    const recovered = Prisma.Decimal.max(ZERO, money(plan.recovered_amount).minus(row.amount));
    const schedule = restoreScheduleBeforeCollection(
      scheduleAsNumbers(plan.installment_schedule, money(plan.installment_amount)),
      money(row.due_amount),
      money(plan.total_amount).minus(recovered),
    );
    await tx.employee_security_deposit_transactions.delete({ where: { id: row.id } });
    await tx.employee_security_deposits.update({
      where: { id: plan.id },
      data: {
        recovered_amount: recovered,
        carried_forward_amount: ZERO,
        status: this.nextStatus(plan.total_amount, recovered, plan.refunded_amount, plan.forfeited_amount),
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
      action: 'SECURITY_DEPOSIT_MARKED_COLLECTED',
      changed_by: actor,
      note: `Security deposit installment for ${cycleLabel(result.period_start)} marked collected outside payroll: ${result.amount.toFixed(2)}${short}. ${notes.trim()}`,
    });
  }

  private async cycleTransactions(depositId: number, tx: Tx): Promise<CycleTxn[]> {
    return tx.employee_security_deposit_transactions.findMany({
      where: { deposit_id: depositId },
      select: {
        id: true,
        type: true,
        created_at: true,
        payroll_run_line_id: true,
        payroll_run_line: { select: { payroll_runs: { select: { period_start: true } } } },
      },
    });
  }

  private async collectedOutsidePayroll(plan: employee_security_deposits, periodStart: Date, tx: Tx): Promise<boolean> {
    return cycleCollectedOutsidePayroll(plan.start_period_start, await this.cycleTransactions(plan.id, tx), periodStart);
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

  /** Row lock so two simultaneous refunds/forfeits/finalizes serialize instead of both reading the same balance. No-op outside a transaction. */
  private async lockEmployeePlans(employeeId: number, tx: Tx): Promise<void> {
    await tx.$queryRaw`SELECT id FROM employee_security_deposits WHERE employee_id = ${employeeId} FOR UPDATE`;
  }

  /** Remaining months as the next payroll will really collect them: carry folded into the first slot, always summing to what is left. */
  private effectiveSchedule(plan: employee_security_deposits): number[] {
    const remaining = Prisma.Decimal.max(ZERO, money(plan.total_amount).minus(plan.recovered_amount));
    if (remaining.lte(0)) return [];
    const slots = parseInstallmentSchedule(plan.installment_schedule, money(plan.installment_amount));
    if (slots.length === 0) return [Number(remaining.toFixed(2))];
    const out = slots.map((n) => money(n));
    out[0] = out[0].plus(plan.carried_forward_amount);
    const diff = remaining.minus(out.reduce((a, b) => a.plus(b), ZERO));
    if (!diff.isZero()) {
      const last = out[out.length - 1].plus(diff);
      if (last.lt(0)) return [Number(remaining.toFixed(2))];
      out[out.length - 1] = last;
    }
    return out.map((n) => Number(n.toFixed(2)));
  }

  private cycleDue(plan: employee_security_deposits): Prisma.Decimal {
    const remaining = money(plan.total_amount).minus(plan.recovered_amount);
    if (remaining.lte(0)) return ZERO;
    return Prisma.Decimal.min(
      nextScheduledAmount(plan.installment_schedule, money(plan.installment_amount)).plus(plan.carried_forward_amount),
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

  private async requireOpenPlan(employeeId: number, user: IJwtStaffPayload | undefined, tx: Tx): Promise<employee_security_deposits> {
    await this.assertEmployee(employeeId, user, tx);
    await this.lockEmployeePlans(employeeId, tx);
    const plan = await tx.employee_security_deposits.findFirst({
      where: { employee_id: employeeId, status: { in: OPEN_STATUSES } },
    });
    if (!plan) {
      throw new NotFoundException('No open security deposit plan for this employee.');
    }
    return plan;
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

  private serializeListRow(plan: employee_security_deposits & {
    employee_profiles: {
      id: number;
      full_name: string | null;
      employee_code: string | null;
      campuses: { campus_name: string } | null;
    };
    transactions: CycleTxn[];
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
      installment_schedule: this.effectiveSchedule(plan),
      start_period_start: dateOnly(plan.start_period_start),
      next_collection_period_start: dateOnly(nextCollectionCycle(plan.start_period_start, plan.transactions)),
      next_due_amount: plan.status === SecurityDepositStatus.ACTIVE ? Number(this.cycleDue(plan)) : 0,
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
  }, isCurrent: boolean) {
    const recovered = Number(plan.recovered_amount);
    const refunded = Number(plan.refunded_amount);
    const forfeited = Number(plan.forfeited_amount);
    const total = Number(plan.total_amount);
    const held = Math.max(0, recovered - refunded - forfeited);
    const cycles = coveredCycles(plan.start_period_start, plan.transactions);
    const lastTxn = [...plan.transactions].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id - b.id,
    ).at(-1);
    return {
      id: plan.id,
      employee_id: plan.employee_id,
      total_amount: total,
      installment_count: plan.installment_count,
      installment_amount: Number(plan.installment_amount),
      installment_schedule: this.effectiveSchedule(plan),
      start_period_start: dateOnly(plan.start_period_start),
      next_collection_period_start: dateOnly(nextCollectionCycle(plan.start_period_start, plan.transactions)),
      next_due_amount: plan.status === SecurityDepositStatus.ACTIVE ? Number(this.cycleDue(plan)) : 0,
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
        period_start: txn.payroll_run_line
          ? dateOnly(txn.payroll_run_line.payroll_runs.period_start)
          : cycles.has(txn) ? dateOnly(cycles.get(txn)!) : null,
        period_end: txn.payroll_run_line
          ? dateOnly(txn.payroll_run_line.payroll_runs.period_end)
          : cycles.has(txn) ? dateOnly(cycleEnd(cycles.get(txn)!)) : null,
        /** TAFSD-459: taken outside payroll and recorded by hand. */
        recorded_manually: txn.type === SecurityDepositTransactionType.DEDUCTION && !txn.payroll_run_line_id,
        /** TAFSD-589: the latest entry on the current plan, recorded outside payroll. The server still refuses once a payroll for that cycle or later is finalized. */
        can_undo: isCurrent && txn === lastTxn && txn.type === SecurityDepositTransactionType.DEDUCTION && !txn.payroll_run_line_id,
      })),
    };
  }
}
