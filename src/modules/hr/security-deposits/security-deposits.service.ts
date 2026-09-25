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
  buildEqualSchedule,
  money,
  nextScheduledAmount,
  parseInstallmentSchedule,
  scheduleAsNumbers,
  scheduleJson,
} from '../installment-schedule.util';
import { ClosePlanDto, CreateSecurityDepositDto, ForfeitSecurityDepositDto, RefundSecurityDepositDto, UpdateInstallmentScheduleDto } from './dto/security-deposits.dto';

const ZERO = new Prisma.Decimal(0);
const OPEN_STATUSES: SecurityDepositStatus[] = [SecurityDepositStatus.ACTIVE, SecurityDepositStatus.COMPLETED];

type Tx = Prisma.TransactionClient;

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function currentCycleStart(): Date {
  const { year, month } = parsePayrollPeriod(currentPayrollPeriodLabel());
  return computePayrollWindow(year, month).periodStart;
}

/** Start (the 26th) of the cycle after the one starting on `periodStart`. */
function nextCycleStart(periodStart: Date): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 26));
}

/** Snaps any date to the start of the 26th-25th cycle that contains it. */
function snapToCycleStart(date: Date): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  return date.getUTCDate() >= 26 ? new Date(Date.UTC(y, m, 26)) : new Date(Date.UTC(y, m - 1, 26));
}

function shiftCycleStart(periodStart: Date, months: number): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + months, 26));
}

/** The plan's queue of cycles is popped once per finalized payroll line, so the next one to collect follows the last finalized deduction — not the wall clock. */
function nextCollectionPeriodStart(startPeriodStart: Date, lastDeductedPeriodStart: Date | null): Date {
  if (!lastDeductedPeriodStart) return startPeriodStart;
  const next = nextCycleStart(lastDeductedPeriodStart);
  return next > startPeriodStart ? next : startPeriodStart;
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
      current: current ? this.serializePlan(current) : null,
      history: history.map((p) => this.serializePlan(p)),
      default_start_period_start: dateOnly(await this.defaultStartFor(employeeId)),
    };
  }

  /**
   * The current cycle — unless the cycle that just ended is still an open
   * (unfinalized) real draft for this employee, in which case that payroll
   * is about to run and would otherwise skip the deposit. A cycle paid
   * outside the system has no draft, so it is never picked by mistake.
   */
  private async defaultStartFor(employeeId: number): Promise<Date> {
    const current = currentCycleStart();
    const previous = shiftCycleStart(current, -1);
    const openDraft = await this.prisma.payroll_run_lines.findFirst({
      where: {
        employee_id: employeeId,
        finalized_at: null,
        payroll_runs: { period_start: previous, is_test: false },
      },
      select: { id: true },
    });
    return openDraft ? previous : current;
  }

  async listOpen(user: IJwtStaffPayload, status?: SecurityDepositStatus) {
    const statuses = status ? [status] : OPEN_STATUSES;
    const where: Prisma.employee_security_depositsWhereInput = {
      status: { in: statuses },
    };
    // Legacy single-campus check stays — ANDed with the universal scope
    // fragment via a real AND (not a shallow merge, which would let one
    // silently overwrite the other on campus_id instead of intersecting).
    // See the scope/tile-permission handoff §5b.
    const employeeProfileClauses: Prisma.employee_profilesWhereInput[] = [];
    if (user.campusId != null) {
      employeeProfileClauses.push({ campus_id: user.campusId });
    }
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
          where: { type: SecurityDepositTransactionType.DEDUCTION, payroll_run_line_id: { not: null } },
          select: { payroll_run_line: { select: { payroll_runs: { select: { period_start: true } } } } },
        },
      },
      orderBy: [{ status: 'asc' }, { start_period_start: 'desc' }, { id: 'desc' }],
    });
    return plans.map((plan) => this.serializeListRow(plan));
  }

  async create(employeeId: number, dto: CreateSecurityDepositDto, user: IJwtStaffPayload) {
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
    const schedule = buildEqualSchedule(total, dto.installment_count);
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
    } else if (monthlyPay.gt(0) && money(schedule[0]).gt(monthlyPay)) {
      warnings.push(
        `The installment of ${money(schedule[0]).toFixed(2)} is more than the monthly pay of ${monthlyPay.toFixed(2)}; each cycle will collect only what pay allows and the rest carries forward.`,
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

  async updateSchedule(employeeId: number, dto: UpdateInstallmentScheduleDto, user: IJwtStaffPayload) {
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

    await this.lockEmployeePlans(line.employee_id, tx);
    const plan = await this.findCollectingPlan(line.employee_id, tx);
    if (!plan) return;
    if (line.payroll_runs.period_start < plan.start_period_start) return;

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

    const recovered = money(plan.recovered_amount).plus(amount);
    const heldAfter = recovered.minus(plan.refunded_amount).minus(plan.forfeited_amount);
    const status = this.nextStatus(plan.total_amount, recovered, plan.refunded_amount, plan.forfeited_amount);
    const remainingAfter = money(plan.total_amount).minus(recovered);
    // Every finalized cycle consumes its slot. A shortfall (pay could not
    // cover the due amount) moves into carry, so schedule + carry always
    // adds up to what is still left — the Edit plan screen opens valid.
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
        installment_schedule: scheduleJson(nextSchedule),
        installment_count: nextSchedule.length,
        installment_amount: money(nextSchedule[0] ?? 0),
      },
    });

    // Later cycles' drafts were snapshotted before this one collected (or
    // fell short); refresh them so they show the real next installment.
    await this.recapOpenDraftLines(plan.employee_id, tx);
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

  private lastDeductedPeriodStart(
    transactions: { payroll_run_line?: { payroll_runs: { period_start: Date } } | null }[],
  ): Date | null {
    let last: Date | null = null;
    for (const txn of transactions) {
      const start = txn.payroll_run_line?.payroll_runs.period_start;
      if (start && (!last || start > last)) last = start;
    }
    return last;
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
    transactions: { payroll_run_line: { payroll_runs: { period_start: Date } } | null }[];
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
      next_collection_period_start: dateOnly(
        nextCollectionPeriodStart(plan.start_period_start, this.lastDeductedPeriodStart(plan.transactions)),
      ),
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
      installment_schedule: this.effectiveSchedule(plan),
      start_period_start: dateOnly(plan.start_period_start),
      next_collection_period_start: dateOnly(
        nextCollectionPeriodStart(plan.start_period_start, this.lastDeductedPeriodStart(plan.transactions)),
      ),
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
        period_start: txn.payroll_run_line ? dateOnly(txn.payroll_run_line.payroll_runs.period_start) : null,
        period_end: txn.payroll_run_line ? dateOnly(txn.payroll_run_line.payroll_runs.period_end) : null,
      })),
    };
  }
}
