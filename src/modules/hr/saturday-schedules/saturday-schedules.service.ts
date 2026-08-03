import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StaffRole } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { FcmService } from '../../../common/fcm/fcm.service';
import { EmployeeNoticeBoardService } from '../../employee-notice-board/employee-notice-board.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CreateSaturdayScheduleDto, ListSaturdaySchedulesQueryDto } from './dto/saturday-schedules.dto';
import { resolveTemplate, isTemplateDisabled } from '../../../utils/notification-templates.util';

const scheduleInclude = {
  employee_profiles: {
    select: {
      id: true,
      full_name: true,
      campus_id: true,
      user_id: true,
      employee_class_section_assignments: {
        select: {
          section_id: true,
          class_id: true,
          sections: { select: { description: true } },
          classes: {
            select: {
              description: true,
              class_code: true,
              segment_id: true,
              segments: { select: { id: true, code: true, name: true, display_order: true } },
            },
          },
        },
      },
    },
  },
  users: { select: { id: true, full_name: true } },
} satisfies Prisma.teacher_saturday_schedulesInclude;

@Injectable()
export class SaturdaySchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly noticeBoard: EmployeeNoticeBoardService,
    private readonly fcmService: FcmService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async create(dto: CreateSaturdayScheduleDto, user: IJwtStaffPayload) {
    this.assertCanManage(user);

    const date = this.parseDate(dto.date);
    if (date.getUTCDay() !== 6) {
      throw new BadRequestException('Only Saturdays can be scheduled');
    }

    const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));

    const employees = await this.prisma.employee_profiles.findMany({
      where: { id: { in: dto.employeeIds } },
      select: { id: true, full_name: true, campus_id: true, user_id: true },
    });

    if (employees.length !== dto.employeeIds.length) {
      throw new BadRequestException('One or more employee IDs were not found');
    }

    for (const employee of employees) {
      this.assertCampusAccess(user, employee.campus_id);
    }

    const existingByEmployee = await this.prisma.teacher_saturday_schedules.groupBy({
      by: ['employee_id'],
      where: {
        employee_id: { in: dto.employeeIds },
        date: { gte: monthStart, lte: monthEnd },
      },
      _count: { _all: true },
    });
    const countMap = new Map(existingByEmployee.map((r) => [r.employee_id, r._count._all]));

    const existingOnDate = await this.prisma.teacher_saturday_schedules.findMany({
      where: { employee_id: { in: dto.employeeIds }, date },
      select: { employee_id: true },
    });
    const alreadyOnDate = new Set(existingOnDate.map((r) => r.employee_id));

    // An employee over the monthly cap is skipped, not fatal to the whole batch —
    // the rest of the selected employees should still get scheduled.
    const cappedIds = new Set<number>();
    const skippedCap: { employee_id: number; full_name: string | null }[] = [];
    for (const employee of employees) {
      const count = countMap.get(employee.id) ?? 0;
      if (count >= 2 && !alreadyOnDate.has(employee.id)) {
        cappedIds.add(employee.id);
        skippedCap.push({ employee_id: employee.id, full_name: employee.full_name });
      }
    }

    const created: Prisma.teacher_saturday_schedulesGetPayload<{ include: typeof scheduleInclude }>[] = [];

    for (const employeeId of dto.employeeIds) {
      if (alreadyOnDate.has(employeeId) || cappedIds.has(employeeId)) continue;

      try {
        const row = await this.prisma.teacher_saturday_schedules.create({
          data: {
            employee_id: employeeId,
            date,
            marked_by: user.sub,
          },
          include: scheduleInclude,
        });
        created.push(row);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          continue;
        }
        throw err;
      }
    }

    // A mandatory Saturday always overrides an employee-scoped STAFF HOLIDAY
    // calendar entry for the same date (see CalendarDayResolverService) — flag
    // it so the admin knows the holiday will be ignored for that employee now,
    // instead of that happening silently.
    const holidayConflicts: { employee_id: number; full_name: string | null }[] = [];
    if (created.length > 0) {
      const conflictRows = await this.prisma.academic_calendar_days.findMany({
        where: {
          employee_id: { in: created.map((r) => r.employee_id) },
          date,
          applies_to: 'STAFF',
          day_type: 'HOLIDAY',
        },
        select: { employee_id: true },
      });
      const conflictSet = new Set(conflictRows.map((r) => r.employee_id));
      for (const row of created) {
        if (conflictSet.has(row.employee_id)) {
          holidayConflicts.push({
            employee_id: row.employee_id,
            full_name: row.employee_profiles.full_name,
          });
        }
      }
    }

    const monthLabel = this.formatMonthLabel(date);
    const affectedCampusIds = new Set<number>();
    for (const employee of employees) {
      if (employee.campus_id != null) affectedCampusIds.add(employee.campus_id);
    }

    for (const campusId of affectedCampusIds) {
      void this.noticeBoard
        .createPost(
          {
            title: `Mandatory Saturday Attendance — ${monthLabel}`,
            body: `Saturday attendance schedules for ${monthLabel} have been updated. Please check your assigned dates in the employee app.`,
            target_roles: [StaffRole.TEACHER],
            campus_ids: [campusId],
          },
          user,
        )
        .catch((err) => console.error('[SaturdaySchedules] Notice board post failed:', err?.message));
    }

    void this.notifyEmployeesMonthlySummary(dto.employeeIds, monthStart, monthEnd, date).catch((err) =>
      console.error('[SaturdaySchedules] Monthly summary notice failed:', err?.message),
    );

    if (holidayConflicts.length > 0) {
      const createdById = new Map(created.map((row) => [row.employee_id, row]));
      const conflictDateLabel = this.formatSaturdayList([date]);
      for (const conflict of holidayConflicts) {
        const userId = createdById.get(conflict.employee_id)?.employee_profiles.user_id;
        if (!userId) continue;
        void this.noticeBoard
          .createScheduleNotice(
            conflict.employee_id,
            userId,
            'Attendance Required Despite Day Off',
            `You have a day off marked for ${conflictDateLabel}, but a mandatory Saturday assignment takes priority — please check in as usual.`,
          )
          .catch((err) => console.error('[SaturdaySchedules] Conflict notice failed:', err?.message));
      }
    }

    if (created.length > 0) {
      const employeeNames = created
        .map((row) => row.employee_profiles.full_name ?? `Employee #${row.employee_profiles.id}`)
        .join(', ');
      void this.auditLogs.log({
        entity_type: 'SATURDAY_SCHEDULE',
        entity_id: this.dateKey(date),
        action: 'CREATED',
        changed_by: user.username,
        note: `Assigned mandatory Saturday ${this.dateKey(date)} to ${created.length} employee(s): ${employeeNames}.`,
      });
    }

    return { created, skipped_cap: skippedCap, holiday_conflicts: holidayConflicts };
  }

  async list(query: ListSaturdaySchedulesQueryDto, user: IJwtStaffPayload) {
    this.assertCanManage(user);

    const [year, month] = query.month.split('-').map((v) => parseInt(v, 10));
    if (!year || !month || month < 1 || month > 12) {
      throw new BadRequestException('month must be YYYY-MM');
    }

    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0));

    const campusIds =
      query.campusId?.length
        ? query.campusId
        : user.role === StaffRole.CAMPUS_ADMIN && user.campusId != null
          ? [user.campusId]
          : undefined;
    if (user.role === StaffRole.CAMPUS_ADMIN && campusIds?.length) {
      for (const campusId of campusIds) {
        this.assertCampusAccess(user, campusId);
      }
    }

    const employeeFilter: Prisma.employee_profilesWhereInput = {};
    if (campusIds?.length) employeeFilter.campus_id = { in: campusIds };
    if (query.sectionId != null) {
      employeeFilter.employee_class_section_assignments = {
        some: { section_id: query.sectionId },
      };
    }

    const where: Prisma.teacher_saturday_schedulesWhereInput = {
      date: { gte: monthStart, lte: monthEnd },
      ...(query.employeeId != null ? { employee_id: query.employeeId } : {}),
      ...(Object.keys(employeeFilter).length > 0 ? { employee_profiles: employeeFilter } : {}),
    };

    return this.prisma.teacher_saturday_schedules.findMany({
      where,
      include: scheduleInclude,
      orderBy: [{ employee_profiles: { full_name: 'asc' } }, { date: 'asc' }],
    });
  }

  async remove(id: number, user: IJwtStaffPayload) {
    this.assertCanManage(user);

    const existing = await this.prisma.teacher_saturday_schedules.findUnique({
      where: { id },
      include: { employee_profiles: { select: { campus_id: true, full_name: true, user_id: true } } },
    });
    if (!existing) throw new NotFoundException('Saturday schedule not found');

    this.assertCampusAccess(user, existing.employee_profiles.campus_id);
    await this.prisma.teacher_saturday_schedules.delete({ where: { id } });

    void this.auditLogs.log({
      entity_type: 'SATURDAY_SCHEDULE',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: user.username,
      note: `Removed Saturday schedule for ${existing.employee_profiles.full_name ?? `employee #${existing.employee_id}`} on ${this.dateKey(existing.date)}.`,
    });

    if (existing.employee_profiles.user_id) {
      void this.noticeBoard
        .createScheduleNotice(
          existing.employee_id,
          existing.employee_profiles.user_id,
          'Saturday Attendance Cancelled',
          `You're no longer required to attend on ${this.formatSaturdayList([existing.date])} — this Saturday has been removed from your schedule.`,
        )
        .catch((err) => console.error('[SaturdaySchedules] Removal notice failed:', err?.message));
    }

    return { id };
  }

  private assertCanManage(user: IJwtStaffPayload) {
    if (user.role !== StaffRole.SUPER_ADMIN && user.role !== StaffRole.CAMPUS_ADMIN) {
      throw new ForbiddenException('Only super admins and campus admins can manage Saturday schedules');
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
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private formatMonthLabel(date: Date): string {
    return date.toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  private formatSaturdayList(dates: Date[]): string {
    const formatted = dates.map((d) =>
      d.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    );
    if (formatted.length === 0) return '';
    if (formatted.length === 1) return formatted[0];
    if (formatted.length === 2) return `${formatted[0]} and ${formatted[1]}`;
    return `${formatted.slice(0, -1).join(', ')} and ${formatted[formatted.length - 1]}`;
  }

  private async notifyEmployeesMonthlySummary(
    employeeIds: number[],
    monthStart: Date,
    monthEnd: Date,
    referenceDate: Date,
  ) {
    const monthLabel = this.formatMonthLabel(referenceDate);

    const rows = await this.prisma.teacher_saturday_schedules.findMany({
      where: {
        employee_id: { in: employeeIds },
        date: { gte: monthStart, lte: monthEnd },
      },
      select: {
        date: true,
        employee_profiles: { select: { user_id: true } },
        employee_id: true,
      },
      orderBy: { date: 'asc' },
    });

    const datesByEmployee = new Map<number, Date[]>();
    const userIdByEmployee = new Map<number, string>();
    for (const row of rows) {
      const bucket = datesByEmployee.get(row.employee_id) ?? [];
      bucket.push(row.date);
      datesByEmployee.set(row.employee_id, bucket);
      if (row.employee_profiles.user_id) {
        userIdByEmployee.set(row.employee_id, row.employee_profiles.user_id);
      }
    }

    await Promise.allSettled(
      [...datesByEmployee.entries()].map(async ([employeeId, dates]) => {
        const userId = userIdByEmployee.get(employeeId);
        if (!userId || dates.length === 0) return;

        const dateList = this.formatSaturdayList(dates);
        const attendanceNote =
          dates.length === 1
            ? 'Please ensure your attendance on that day.'
            : dates.length === 2
              ? 'Please ensure your attendance on both days.'
              : 'Please ensure your attendance on all assigned days.';
        if (await isTemplateDisabled(this.prisma, 'notif_staff_saturday_title')) return;

        const vars = { month: monthLabel, date_list: dateList, attendance_note: attendanceNote };
        const title = await resolveTemplate(this.prisma, 'notif_staff_saturday_title',
          'Working Saturday Notice', vars);
        const body = await resolveTemplate(this.prisma, 'notif_staff_saturday_body',
          'You are required to attend school on the following Saturday(s) in {month}: {date_list}. {attendance_note}', vars);

        await this.fcmService.sendToUsers([userId], title, body, { type: 'EMPLOYEE_NOTICE' });
      }),
    );
  }
}
