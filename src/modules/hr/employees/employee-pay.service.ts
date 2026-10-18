import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { pktDayStart, todayPkt } from './employee-timings.service';

type Tx = Prisma.TransactionClient;

export type PayChangeResult = {
  status: 'APPLIED' | 'SCHEDULED' | 'UNCHANGED';
  effective_from: string;
  warnings: string[];
};

const money = (v: Prisma.Decimal | string | number | null | undefined) =>
  v == null || v === '' ? null : new Prisma.Decimal(v).toFixed(2);
const fmtPay = (v: string | null) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * TAFSD-372: monthly pay changes with an effective-from date, the same way
 * EmployeeTimingsService handles timings (TAFSD-369):
 * - today or earlier: applied now; the progression timeline is split at the
 *   start of that day (PKT) and the new pay runs forward. Refused when the
 *   pay changed again later (another change or a salary increment).
 * - later: kept in employee_scheduled_pay_changes, applied on the day.
 * Payroll pays each day of a cycle at the pay in effect on it.
 */
@Injectable()
export class EmployeePayService {
  private readonly logger = new Logger(EmployeePayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async changePay(
    employeeId: number,
    input: { monthly_pay: number | null; effective_from?: string; notes?: string | null },
    changedBy: string,
  ): Promise<PayChangeResult> {
    const effective = input.effective_from ?? todayPkt();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) throw new BadRequestException('effective_from must be YYYY-MM-DD.');
    if (input.monthly_pay != null && (!Number.isFinite(input.monthly_pay) || input.monthly_pay < 0)) {
      throw new BadRequestException('Monthly pay must be zero or more.');
    }
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { full_name: true, monthly_pay: true },
    });
    if (!employee) throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    const next = money(input.monthly_pay);
    const name = employee.full_name ?? `#${employeeId}`;

    if (effective > todayPkt()) {
      if (money(employee.monthly_pay) === next) return { status: 'UNCHANGED', effective_from: effective, warnings: [] };
      const date = new Date(`${effective}T00:00:00Z`);
      await this.prisma.employee_scheduled_pay_changes.upsert({
        where: { employee_id_effective_from: { employee_id: employeeId, effective_from: date } },
        create: { employee_id: employeeId, effective_from: date, monthly_pay: next, changed_by: changedBy, notes: input.notes ?? null },
        update: { monthly_pay: next, changed_by: changedBy, notes: input.notes ?? null, recorded_at: new Date() },
      });
      this.auditLogs.log({
        entity_type: 'EMPLOYEE',
        entity_id: String(employeeId),
        action: 'UPDATED',
        section: 'hr',
        field: 'Monthly Pay (scheduled)',
        old_value: money(employee.monthly_pay) ?? undefined,
        new_value: next ?? undefined,
        note: `${name} — from ${formatDay(effective)}: pay ${fmtPay(money(employee.monthly_pay))} → ${fmtPay(next)}`,
        changed_by: changedBy,
      });
      return { status: 'SCHEDULED', effective_from: effective, warnings: [] };
    }

    const { status, previous } = await this.prisma.$transaction((tx) =>
      this.applyInTx(tx, employeeId, next, effective, changedBy, new Date(), input.notes ?? null),
    );
    if (status === 'UNCHANGED') return { status, effective_from: effective, warnings: [] };
    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'Monthly Pay',
      old_value: previous ?? undefined,
      new_value: next ?? undefined,
      note: `${name} — effective ${formatDay(effective)}: pay ${fmtPay(previous)} → ${fmtPay(next)}`,
      changed_by: changedBy,
    });
    return { status, effective_from: effective, warnings: await this.finalizedPayrollWarnings(employeeId, effective) };
  }

  /** Set the pay from the start of `effective` (PKT) on the timeline and the profile. */
  async applyInTx(
    tx: Tx,
    employeeId: number,
    next: string | null,
    effective: string,
    changedBy: string | null,
    recordedAt: Date,
    notes: string | null,
  ): Promise<{ status: 'APPLIED' | 'UNCHANGED'; previous: string | null }> {
    const start = pktDayStart(effective);
    const periods = await tx.employee_progression_periods.findMany({
      where: { employee_id: employeeId },
      orderBy: { valid_from: 'asc' },
    });
    let previous: string | null = null;

    if (periods.length) {
      let idx = -1;
      periods.forEach((p, i) => {
        if (p.valid_from.getTime() <= start.getTime()) idx = i;
      });
      if (idx < 0) {
        throw new BadRequestException(
          `${formatDay(effective)} is before this employee's history starts (${periods[0].valid_from.toISOString().slice(0, 10)}).`,
        );
      }
      const covering = periods[idx];
      previous = money(covering.monthly_pay);
      const laterChange = periods.slice(idx + 1).find((p) => money(p.monthly_pay) !== previous);
      if (laterChange) {
        throw new BadRequestException(
          `The pay was changed again with effect from ${laterChange.valid_from.toISOString().slice(0, 10)}` +
            `${laterChange.change_type === 'SALARY_INCREMENT' ? ' (a salary increment)' : ''}. ` +
            `Make this change effective from that date or later.`,
        );
      }
      if (previous === next) {
        await tx.employee_profiles.update({ where: { id: employeeId }, data: { monthly_pay: next } });
        return { status: 'UNCHANGED', previous };
      }
      const changeNote = (notes || `Pay ${fmtPay(previous)} → ${fmtPay(next)}`).slice(0, 255);
      if (covering.valid_from.getTime() === start.getTime()) {
        await tx.employee_progression_periods.update({
          where: { id: covering.id },
          data: {
            monthly_pay: next,
            change_type: covering.change_type === 'ONBOARDED' ? covering.change_type : 'PAY_CHANGED',
            changed_by: changedBy,
            notes: changeNote,
            recorded_at: recordedAt,
          },
        });
      } else {
        const { id: _id, valid_from: _vf, valid_to, recorded_at: _ra, change_type: _ct, changed_by: _cb, notes: _n, ...rest } = covering;
        await tx.employee_progression_periods.update({ where: { id: covering.id }, data: { valid_to: start } });
        await tx.employee_progression_periods.create({
          data: {
            ...rest,
            class_sections: (rest.class_sections ?? Prisma.DbNull) as Prisma.InputJsonValue,
            timings: (rest.timings ?? Prisma.DbNull) as Prisma.InputJsonValue,
            monthly_pay: next,
            change_type: 'PAY_CHANGED',
            changed_by: changedBy,
            notes: changeNote,
            valid_from: start,
            valid_to,
            recorded_at: recordedAt,
          },
        });
      }
      for (const p of periods.slice(idx + 1)) {
        await tx.employee_progression_periods.update({ where: { id: p.id }, data: { monthly_pay: next } });
      }
    } else {
      const row = await tx.employee_profiles.findUnique({ where: { id: employeeId }, select: { monthly_pay: true } });
      previous = money(row?.monthly_pay);
      if (previous === next) return { status: 'UNCHANGED', previous };
    }

    await tx.employee_profiles.update({ where: { id: employeeId }, data: { monthly_pay: next } });
    return { status: 'APPLIED', previous };
  }

  private async finalizedPayrollWarnings(employeeId: number, effective: string): Promise<string[]> {
    const lines = await this.prisma.payroll_run_lines.findMany({
      where: {
        employee_id: employeeId,
        payroll_runs: { status: 'FINALIZED', period_end: { gte: new Date(`${effective}T00:00:00Z`) } },
      },
      select: { payroll_runs: { select: { period_start: true, period_end: true } } },
    });
    return lines.map(
      (l) =>
        `The ${l.payroll_runs.period_start.toISOString().slice(0, 10)} → ${l.payroll_runs.period_end.toISOString().slice(0, 10)} payroll is finalized and already covers this date; regenerate this employee's line to apply it.`,
    );
  }

  async listScheduled(employeeId: number) {
    const [rows, employee] = await Promise.all([
      this.prisma.employee_scheduled_pay_changes.findMany({ where: { employee_id: employeeId }, orderBy: { effective_from: 'asc' } }),
      this.prisma.employee_profiles.findUnique({ where: { id: employeeId }, select: { monthly_pay: true } }),
    ]);
    return rows.map((r) => ({
      id: r.id,
      effective_from: r.effective_from.toISOString().slice(0, 10),
      monthly_pay: money(r.monthly_pay),
      changed_by: r.changed_by,
      recorded_at: r.recorded_at,
      summary: `Pay ${fmtPay(money(employee?.monthly_pay))} → ${fmtPay(money(r.monthly_pay))}`,
    }));
  }

  async cancelScheduled(employeeId: number, id: number, changedBy: string) {
    const row = await this.prisma.employee_scheduled_pay_changes.findFirst({ where: { id, employee_id: employeeId } });
    if (!row) throw new NotFoundException('Scheduled change not found');
    await this.prisma.employee_scheduled_pay_changes.delete({ where: { id } });
    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'Monthly Pay (scheduled)',
      note: `Cancelled the pay change scheduled from ${formatDay(row.effective_from.toISOString().slice(0, 10))}`,
      changed_by: changedBy,
    });
    return { cancelled: true };
  }

  @Cron('7 0 * * *', { name: 'apply-scheduled-pay-changes', timeZone: 'Asia/Karachi' })
  async applyDueScheduledChanges(): Promise<{ applied: number; failed: number }> {
    const due = await this.prisma.employee_scheduled_pay_changes.findMany({
      where: { effective_from: { lte: new Date(`${todayPkt()}T00:00:00Z`) } },
      orderBy: { effective_from: 'asc' },
    });
    let applied = 0;
    let failed = 0;
    for (const row of due) {
      const effective = row.effective_from.toISOString().slice(0, 10);
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.applyInTx(tx, row.employee_id, money(row.monthly_pay), effective, row.changed_by, row.recorded_at, row.notes);
          await tx.employee_scheduled_pay_changes.delete({ where: { id: row.id } });
        });
        applied++;
      } catch (err) {
        failed++;
        this.logger.warn(`Scheduled pay change ${row.id} (employee ${row.employee_id}, ${effective}) not applied: ${(err as Error).message}`);
      }
    }
    if (due.length) this.logger.log(`Scheduled pay changes: ${applied} applied, ${failed} failed`);
    return { applied, failed };
  }
}
