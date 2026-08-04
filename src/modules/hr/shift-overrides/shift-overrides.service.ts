import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StaffRole } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { EmployeeNoticeBoardService } from '../../employee-notice-board/employee-notice-board.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CalendarDayResolverService } from '../calendar/calendar-day-resolver.service';
import { CreateShiftOverridesDto, ListShiftOverridesQueryDto } from './dto/shift-overrides.dto';

const toTime = (value?: string) => (value ? new Date(`1970-01-01T${value}:00Z`) : null);

function formatDatePKT(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Karachi',
  }).format(date);
}

function formatTimeUTC(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  }).format(date);
}

function minutesOfDay(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** Describes what an override actually changes relative to the employee's normal
 *  reporting/leaving time, so the notice can say "earlier start" / "early leave"
 *  instead of just restating the new time with no context. */
function describeShiftChange(
  newStart: Date | null,
  newEnd: Date | null,
  baseStart: Date | null,
  baseEnd: Date | null,
): string {
  const parts: string[] = [];

  if (newStart) {
    const label = formatTimeUTC(newStart);
    if (baseStart) {
      const diff = minutesOfDay(newStart) - minutesOfDay(baseStart);
      if (diff > 0) parts.push(`check-in moved to ${label} (later start)`);
      else if (diff < 0) parts.push(`check-in moved to ${label} (earlier start)`);
      else parts.push(`check-in at ${label}`);
    } else {
      parts.push(`check-in at ${label}`);
    }
  }

  if (newEnd) {
    const label = formatTimeUTC(newEnd);
    if (baseEnd) {
      const diff = minutesOfDay(newEnd) - minutesOfDay(baseEnd);
      if (diff < 0) parts.push(`check-out moved to ${label} (early leave)`);
      else if (diff > 0) parts.push(`check-out moved to ${label} (extended day)`);
      else parts.push(`check-out at ${label}`);
    } else {
      parts.push(`check-out at ${label}`);
    }
  }

  return parts.join(', ');
}

const overrideInclude = {
  employee_profiles: {
    select: { id: true, full_name: true, campus_id: true, user_id: true, reporting_time: true, leaving_time: true },
  },
} satisfies Prisma.employee_shift_overridesInclude;

@Injectable()
export class ShiftOverridesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly noticeBoard: EmployeeNoticeBoardService,
    private readonly calendarResolver: CalendarDayResolverService,
  ) {}

  async bulkCreate(dto: CreateShiftOverridesDto, user: IJwtStaffPayload) {
    this.assertCanManage(user);

    if (dto.override_start_time == null && dto.override_end_time == null) {
      throw new BadRequestException('Set at least one of override_start_time or override_end_time');
    }

    const uniqueEmployeeIds = [...new Set(dto.employee_ids)];
    const employees = await this.prisma.employee_profiles.findMany({
      where: { id: { in: uniqueEmployeeIds } },
      select: {
        id: true,
        full_name: true,
        campus_id: true,
        department_id: true,
        staff_category_id: true,
        days_per_week: true,
        staff_categories: { select: { code: true } },
        employee_work_schedules: { select: { day_of_week: true, is_working: true } },
      },
    });
    if (employees.length !== uniqueEmployeeIds.length) {
      throw new BadRequestException('One or more employee IDs were not found');
    }
    for (const employee of employees) {
      this.assertCampusAccess(user, employee.campus_id);
    }

    const startTime = toTime(dto.override_start_time);
    const endTime = toTime(dto.override_end_time);
    const uniqueDates = [...new Set(dto.dates)];
    const dateObjs = uniqueDates.map((d) => this.parseDate(d));

    // Shift time only applies on working days — reject day-off pairs before any upsert.
    await this.assertAllWorkingDays(employees, uniqueDates, dateObjs);

    const rows = await Promise.all(
      employees.flatMap((employee) =>
        uniqueDates.map((dateStr) => {
          const date = this.parseDate(dateStr);
          return this.prisma.employee_shift_overrides.upsert({
            where: { employee_id_date: { employee_id: employee.id, date } },
            create: {
              employee_id: employee.id,
              date,
              override_start_time: startTime,
              override_end_time: endTime,
              reason: dto.reason,
              created_by: user.sub,
            },
            update: {
              override_start_time: startTime,
              override_end_time: endTime,
              reason: dto.reason,
              created_by: user.sub,
            },
            include: overrideInclude,
          });
        }),
      ),
    );

    const employeeNames = employees.map((e) => e.full_name ?? `employee #${e.id}`).join(', ');
    void this.auditLogs.log({
      entity_type: 'EMPLOYEE_SHIFT_OVERRIDE',
      entity_id: uniqueEmployeeIds.join(','),
      action: 'CREATED',
      changed_by: user.username,
      note: `Set shift override for ${employeeNames} on ${uniqueDates.length} day(s): ${uniqueDates.join(', ')}.`,
    });

    for (const row of rows) {
      const userId = row.employee_profiles.user_id;
      if (!userId) continue;
      const changeSummary = describeShiftChange(
        startTime,
        endTime,
        row.employee_profiles.reporting_time,
        row.employee_profiles.leaving_time,
      );
      void this.noticeBoard
        .createScheduleNotice(
          row.employee_id,
          userId,
          `Schedule Update for ${formatDatePKT(row.date)}`,
          `Your hours on ${formatDatePKT(row.date)} have been changed: ${changeSummary}.`,
        )
        .catch((err) => console.error('[ShiftOverrides] Schedule notice failed:', err?.message));
    }

    return rows;
  }

  async list(query: ListShiftOverridesQueryDto, user: IJwtStaffPayload) {
    const where: Prisma.employee_shift_overridesWhereInput = {};

    if (query.employee_id != null) {
      const employee = await this.prisma.employee_profiles.findUnique({
        where: { id: query.employee_id },
        select: { campus_id: true },
      });
      if (employee) this.assertCampusAccess(user, employee.campus_id);
      where.employee_id = query.employee_id;
    } else if (user.role !== StaffRole.SUPER_ADMIN && user.campusId) {
      where.employee_profiles = { campus_id: user.campusId };
    }

    if (query.date_from || query.date_to) {
      where.date = {
        ...(query.date_from ? { gte: this.parseDate(query.date_from) } : {}),
        ...(query.date_to ? { lte: this.parseDate(query.date_to) } : {}),
      };
    }

    return this.prisma.employee_shift_overrides.findMany({
      where,
      include: overrideInclude,
      orderBy: [{ date: 'asc' }],
    });
  }

  async remove(id: number, user: IJwtStaffPayload) {
    const existing = await this.prisma.employee_shift_overrides.findUnique({
      where: { id },
      include: { employee_profiles: { select: { campus_id: true, full_name: true, user_id: true } } },
    });
    if (!existing) throw new NotFoundException('Shift override not found');

    this.assertCanManage(user);
    this.assertCampusAccess(user, existing.employee_profiles.campus_id);
    await this.prisma.employee_shift_overrides.delete({ where: { id } });

    void this.auditLogs.log({
      entity_type: 'EMPLOYEE_SHIFT_OVERRIDE',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: user.username,
      note: `Removed shift override for ${existing.employee_profiles.full_name ?? `employee #${existing.employee_id}`} on ${this.dateKey(existing.date)}.`,
    });

    if (existing.employee_profiles.user_id) {
      void this.noticeBoard
        .createScheduleNotice(
          existing.employee_id,
          existing.employee_profiles.user_id,
          `Schedule Update for ${formatDatePKT(existing.date)}`,
          `Your schedule change for ${formatDatePKT(existing.date)} has been removed — your normal hours apply.`,
        )
        .catch((err) => console.error('[ShiftOverrides] Removal notice failed:', err?.message));
    }

    return { id };
  }

  private assertCanManage(user: IJwtStaffPayload) {
    if (user.role !== StaffRole.SUPER_ADMIN && user.role !== StaffRole.CAMPUS_ADMIN) {
      throw new ForbiddenException('Only super admins and campus admins can manage shift overrides');
    }
  }

  private assertCampusAccess(user: IJwtStaffPayload, employeeCampusId: number | null) {
    if (user.role === StaffRole.SUPER_ADMIN) return;
    if (employeeCampusId == null) {
      throw new ForbiddenException('You do not have access to this employee');
    }
    if (user.campusId && user.campusId !== employeeCampusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }
  }

  private dateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private parseDate(dateStr: string): Date {
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
    return d;
  }

  /**
   * Time overrides only make sense on working days. Uses the same STAFF day
   * resolution as attendance (calendar scopes + weekly schedule + mandatory
   * Saturdays) so a holiday / weekend / scheduled off day is rejected.
   */
  private async assertAllWorkingDays(
    employees: {
      id: number;
      full_name: string | null;
      campus_id: number | null;
      department_id: number | null;
      staff_category_id: number | null;
      days_per_week: number | null;
      staff_categories: { code: string | null } | null;
      employee_work_schedules: { day_of_week: number; is_working: boolean }[];
    }[],
    uniqueDates: string[],
    dateObjs: Date[],
  ): Promise<void> {
    const missingCampus = employees.filter((e) => e.campus_id == null);
    if (missingCampus.length > 0) {
      const names = missingCampus
        .slice(0, 5)
        .map((e) => e.full_name ?? `Employee #${e.id}`)
        .join(', ');
      throw new BadRequestException(
        `Cannot set a shift time override: ${names}` +
          (missingCampus.length > 5 ? ` and ${missingCampus.length - 5} more` : '') +
          ' have no campus assigned.',
      );
    }

    const dateFrom = dateObjs.reduce((min, d) => (d < min ? d : min), dateObjs[0]);
    const dateTo = dateObjs.reduce((max, d) => (d > max ? d : max), dateObjs[0]);

    const byCampus = new Map<number, typeof employees>();
    for (const employee of employees) {
      const cid = employee.campus_id!;
      const bucket = byCampus.get(cid) ?? [];
      bucket.push(employee);
      byCampus.set(cid, bucket);
    }

    const campusRows = new Map<number, Awaited<ReturnType<CalendarDayResolverService['loadStaffCalendarRows']>>>();
    await Promise.all(
      [...byCampus.keys()].map(async (campusId) => {
        campusRows.set(
          campusId,
          await this.calendarResolver.loadStaffCalendarRows(campusId, dateFrom, dateTo),
        );
      }),
    );

    const hasSaturday = dateObjs.some((d) => d.getUTCDay() === 6);
    const mandatoryByEmployee = hasSaturday
      ? await this.calendarResolver.loadMandatorySaturdayDatesForEmployees(
          employees.map((e) => e.id),
          dateFrom,
          dateTo,
        )
      : new Map<number, Set<string>>();

    type OffHit = { name: string; date: string; reason: string };
    const offHits: OffHit[] = [];

    for (const employee of employees) {
      const rows = campusRows.get(employee.campus_id!) ?? [];
      const name = employee.full_name ?? `Employee #${employee.id}`;
      const saturdaySet = mandatoryByEmployee.get(employee.id);

      for (let i = 0; i < uniqueDates.length; i++) {
        const date = dateObjs[i];
        const resolved = this.calendarResolver.resolveStaffDayFromRows(
          rows,
          date,
          employee.id,
          employee.department_id,
          employee.staff_category_id,
          employee.staff_categories?.code ?? null,
          employee.days_per_week,
          employee.employee_work_schedules,
          saturdaySet,
        );

        if (resolved.isWorkingDay) continue;

        const label =
          resolved.description ??
          (resolved.dayType === 'WEEKEND'
            ? 'Weekend'
            : resolved.dayType === 'HOLIDAY'
              ? 'Holiday'
              : 'Day off');
        offHits.push({ name, date: uniqueDates[i], reason: label });
      }
    }

    if (offHits.length === 0) return;

    const preview = offHits
      .slice(0, 8)
      .map((h) => `${h.name} on ${h.date} (${h.reason})`)
      .join('; ');
    const more = offHits.length > 8 ? ` …and ${offHits.length - 8} more` : '';
    throw new BadRequestException(
      `Cannot set a shift time override on a day off — the employee must be scheduled to work that day. ${preview}${more}`,
    );
  }
}
