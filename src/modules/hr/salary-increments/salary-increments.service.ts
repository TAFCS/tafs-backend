import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { EmployeeProgressionService, EmployeeProgressionSnapshot } from '../employees/employee-progression.service';
import { DueSalaryIncrementsQueryDto, SalaryIncrementApplyDto, UpdateSalaryIncrementSettingsDto } from './dto/salary-increments.dto';

export const dateOnly = (value: string | Date) => new Date(`${typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10)}T00:00:00.000Z`);
const isoDate = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
export function addMonthsSafe(date: Date, months: number) { const d = new Date(date); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months); d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate())); return d; }
// Whole calendar months from `from` to `until`, floored. Subtract one when the
// day-of-month has not yet been reached, i.e. the final month is still partial.
export function monthsRemaining(from: Date, until: Date) { return (until.getUTCFullYear() - from.getUTCFullYear()) * 12 + until.getUTCMonth() - from.getUTCMonth() - (until.getUTCDate() < from.getUTCDate() ? 1 : 0); }
export const daysBetween = (from: Date, until: Date) => Math.round((until.getTime() - from.getTime()) / 86_400_000);
/** Pay after an increment. Mirrors the money math used when applying. */
export function computeNewPay(pay: number, mode: 'PERCENTAGE' | 'FIXED_AMOUNT', value: number) {
  const raw = mode === 'PERCENTAGE' ? pay * (1 + value / 100) : pay + value;
  return Math.round((raw + Number.EPSILON) * 100) / 100;
}

@Injectable()
export class SalaryIncrementsService {
  constructor(private readonly prisma: PrismaService, private readonly progression: EmployeeProgressionService) {}
  private async settings() { return this.prisma.salary_increment_settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} }); }
  async getSettings() { return this.settings(); }
  async updateSettings(dto: UpdateSalaryIncrementSettingsDto, user: IJwtStaffPayload) { return this.prisma.salary_increment_settings.upsert({ where: { id: 1 }, create: { id: 1, ...dto, updated_by: user.username ?? user.sub }, update: { ...dto, updated_by: user.username ?? user.sub } }); }
  private status(employee: any, defaultCycle: number, windowDays: number) { const cycle = employee.increment_cycle_months ?? defaultCycle; const anchor = employee.last_increment_at ?? employee.join_date; if (!anchor) return { cycle_months: cycle, anchor_date: null, next_due_date: null, months_remaining: null, days_remaining: null, status: 'MISSING_ANCHOR' }; const today = dateOnly(new Date()); const next = addMonthsSafe(dateOnly(anchor), cycle); const left = monthsRemaining(today, next); const days = daysBetween(today, next); return { cycle_months: cycle, anchor_date: isoDate(dateOnly(anchor)), next_due_date: isoDate(next), months_remaining: left, days_remaining: days, status: left <= 0 ? 'DUE' : days <= windowDays ? 'UPCOMING' : 'OK' }; }
  async due(query: DueSalaryIncrementsQueryDto, user: IJwtStaffPayload) { const setting = await this.settings(); const where: Prisma.employee_profilesWhereInput = { employment_status: 'ACTIVE', ...(user.campusId != null ? { campus_id: user.campusId } : query.campus_ids?.length ? { campus_id: { in: query.campus_ids } } : {}), ...(query.department_ids?.length ? { department_id: { in: query.department_ids } } : {}), ...(query.segment_ids?.length ? { segment_id: { in: query.segment_ids } } : {}), ...(query.staff_category_ids?.length ? { staff_category_id: { in: query.staff_category_ids } } : {}), ...(query.employment_types?.length ? { employment_type: { in: query.employment_types } } : {}), ...(query.search ? { OR: [{ full_name: { contains: query.search, mode: 'insensitive' } }, { employee_code: { contains: query.search, mode: 'insensitive' } }] } : {}) };
    const rows = await this.prisma.employee_profiles.findMany({ where, select: { id: true, full_name: true, employee_code: true, monthly_pay: true, join_date: true, last_increment_at: true, increment_cycle_months: true, employment_status: true, employment_type: true, campuses: { select: { campus_name: true } }, departments: { select: { name: true } }, segments: { select: { name: true } }, staff_categories: { select: { name: true } } }, orderBy: { full_name: 'asc' } });
    return rows.map(e => ({ employee_id: e.id, name: e.full_name, employee_code: e.employee_code, monthly_pay: e.monthly_pay ? Number(e.monthly_pay) : null, join_date: isoDate(e.join_date), last_increment_at: isoDate(e.last_increment_at), employment_status: e.employment_status, employment_type: e.employment_type ?? null, campus: e.campuses?.campus_name ?? null, department: e.departments?.name ?? null, segment: e.segments?.name ?? null, staff_category: e.staff_categories?.name ?? null, ...this.status(e, setting.default_cycle_months, setting.upcoming_window_days) })).filter((row: any) => { if (query.status === 'all' || !query.status) return true; if (query.status === 'due') return row.status === 'DUE'; return row.status === 'UPCOMING'; }); }
  async employeeStatus(id: number) { const [employee, setting] = await Promise.all([this.prisma.employee_profiles.findUnique({ where: { id } }), this.settings()]); if (!employee) throw new NotFoundException('Employee not found'); return this.status(employee, setting.default_cycle_months, setting.upcoming_window_days); }
  async history(id: number) { return this.prisma.salary_increments.findMany({ where: { employee_id: id }, orderBy: [{ effective_from: 'desc' }, { id: 'desc' }] }); }
  /** Organisation-level history and headline figures for the increment workspace. */
  async analytics(user: IJwtStaffPayload) {
    const where: Prisma.salary_incrementsWhereInput = user.campusId == null
      ? {}
      : { employee_profiles: { campus_id: user.campusId } };
    const [aggregate, increments, dueRows] = await Promise.all([
      this.prisma.salary_increments.aggregate({
        where,
        _count: { id: true },
        _sum: { previous_pay: true, new_pay: true },
        _avg: { previous_pay: true, new_pay: true },
      }),
      this.prisma.salary_increments.findMany({
        where,
        include: { employee_profiles: { select: { full_name: true, employee_code: true, campuses: { select: { campus_name: true } }, departments: { select: { name: true } } } } },
        orderBy: [{ effective_from: 'desc' }, { id: 'desc' }],
        take: 100,
      }),
      this.due({ status: 'due' }, user),
    ]);
    const records = increments.map((row) => {
      const previous = Number(row.previous_pay); const next = Number(row.new_pay); const amount = next - previous;
      return { id: row.id, employee_id: row.employee_id, employee_name: row.employee_profiles.full_name, employee_code: row.employee_profiles.employee_code, campus: row.employee_profiles.campuses?.campus_name ?? null, department: row.employee_profiles.departments?.name ?? null, mode: row.mode, percentage: row.percentage == null ? null : Number(row.percentage), fixed_amount: row.fixed_amount == null ? null : Number(row.fixed_amount), previous_pay: previous, new_pay: next, increment_amount: amount, increment_percent: previous ? Number(((amount / previous) * 100).toFixed(2)) : null, annual_impact: amount * 12, effective_from: isoDate(row.effective_from), applied_at: row.applied_at.toISOString(), applied_by: row.applied_by, notes: row.notes, bulk_batch_id: row.bulk_batch_id };
    });
    const previousTotal = Number(aggregate._sum.previous_pay ?? 0); const newTotal = Number(aggregate._sum.new_pay ?? 0);
    return { summary: { total_increments: aggregate._count.id, due_count: dueRows.length, monthly_payroll_increase: Number((newTotal - previousTotal).toFixed(2)), annual_payroll_impact: Number(((newTotal - previousTotal) * 12).toFixed(2)), average_increment_amount: aggregate._count.id ? Number(((newTotal - previousTotal) / aggregate._count.id).toFixed(2)) : 0, average_increment_percent: records.length ? Number((records.reduce((sum, r) => sum + (r.increment_percent ?? 0), 0) / records.length).toFixed(2)) : 0 }, records };
  }
  async updateEmployeeCycle(id: number, cycle: number | null) { if (cycle != null && (!Number.isInteger(cycle) || cycle < 1 || cycle > 120)) throw new BadRequestException('Increment cycle must be a whole number from 1 to 120 months.'); return this.prisma.employee_profiles.update({ where: { id }, data: { increment_cycle_months: cycle } }); }
  private newPay(pay: Prisma.Decimal, dto: SalaryIncrementApplyDto) { return dto.mode === 'PERCENTAGE' ? pay.mul(new Prisma.Decimal(1).plus(new Prisma.Decimal(dto.percentage!).div(100))).toDecimalPlaces(2) : pay.plus(dto.fixed_amount!).toDecimalPlaces(2); }
  async preview(dto: SalaryIncrementApplyDto, user: IJwtStaffPayload) { const ids = [...new Set(dto.employee_ids)]; const [setting, employees] = await Promise.all([this.settings(), this.prisma.employee_profiles.findMany({ where: { id: { in: ids } } })]); return ids.map(id => { const e = employees.find(x => x.id === id); if (!e) return { employee_id: id, error: 'Employee not found' }; if (user.campusId != null && e.campus_id !== user.campusId) return { employee_id: id, error: 'Employee is outside your campus' }; if (e.employment_status !== 'ACTIVE') return { employee_id: id, error: 'Only active employees can receive an increment' }; if (!e.monthly_pay) return { employee_id: id, error: 'Monthly pay is not set' }; const next = this.newPay(e.monthly_pay, dto); return { employee_id: id, employee_name: e.full_name, previous_pay: Number(e.monthly_pay), new_pay: Number(next), annual_pay_before: Number(e.monthly_pay.mul(12)), annual_pay_after: Number(next.mul(12)), increment_amount: Number(next.minus(e.monthly_pay)), ...this.status(e, setting.default_cycle_months, setting.upcoming_window_days) }; }); }
  async apply(dto: SalaryIncrementApplyDto, user: IJwtStaffPayload) { const preview = await this.preview(dto, user); const defaultCycle = (await this.settings()).default_cycle_months; const batch = new Set(dto.employee_ids).size > 1 ? randomUUID() : null; const effective = dateOnly(dto.effective_from); const successes: any[] = [], failures = preview.filter((x: any) => x.error); for (const item of preview.filter((x: any) => !x.error)) { try { await this.prisma.$transaction(async tx => { const e = await tx.employee_profiles.findUniqueOrThrow({ where: { id: item.employee_id }, include: { employee_class_section_assignments: true } }); const old = e.monthly_pay!; const next = this.newPay(old, dto); const updated = await tx.employee_profiles.update({ where: { id: e.id }, data: { monthly_pay: next, last_increment_at: effective } }); const snapshot: EmployeeProgressionSnapshot = { campusId: updated.campus_id, segmentId: updated.segment_id, departmentId: updated.department_id, staffCategoryId: updated.staff_category_id, reportingManagerId: updated.reporting_manager_id, jobTitle: updated.job_title, employmentType: updated.employment_type, employmentStatus: updated.employment_status, monthlyPay: next, payrollEnabled: updated.payroll_enabled, classSections: e.employee_class_section_assignments.map(a => ({ class_id: a.class_id, section_id: a.section_id })) }; await this.progression.recordProgressionChange(tx, { ...snapshot, employeeId: e.id, changeType: 'SALARY_INCREMENT', changedBy: user.username ?? user.sub ?? null, notes: dto.notes, at: effective }); await tx.salary_increments.create({ data: { employee_id: e.id, mode: dto.mode, percentage: dto.mode === 'PERCENTAGE' ? dto.percentage : null, fixed_amount: dto.mode === 'FIXED_AMOUNT' ? dto.fixed_amount : null, previous_pay: old, new_pay: next, cycle_months_used: e.increment_cycle_months ?? defaultCycle, effective_from: effective, applied_by: user.username ?? user.sub ?? null, notes: dto.notes ?? null, bulk_batch_id: batch } }); }); successes.push(item); } catch (err: any) { failures.push({ employee_id: item.employee_id, error: err.message ?? 'Could not apply increment' }); } } return { bulk_batch_id: batch, successes, failures }; }
}
