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
import { auditActorLabel } from '../../../common/utils/audit-actor.util';
import {
  CreateSaturdayScheduleDto,
  ListSaturdaySchedulesQueryDto,
} from './dto/saturday-schedules.dto';
import {
  resolveTemplate,
  isTemplateDisabled,
} from '../../../utils/notification-templates.util';

// Max mandatory Saturdays that can be assigned to one employee in one payroll
// month. Employees already at this count are skipped (and reported back in
// skipped_cap) rather than failing the whole batch.
const MONTHLY_SATURDAY_CAP = 5;

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
              segments: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  display_order: true,
                },
              },
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

    const rawDates = dto.dates.map((d) => this.parseDate(d));
    for (const date of rawDates) {
      if (date.getUTCDay() !== 6) {
        throw new BadRequestException('Only Saturdays can be scheduled');
      }
    }
    const uniqueDates = [
      ...new Map(rawDates.map((d) => [this.dateKey(d), d])).values(),
    ];

    const monthRanges = new Map<string, { start: Date; end: Date }>();
    for (const d of uniqueDates) {
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      if (!monthRanges.has(key)) {
        monthRanges.set(key, {
          start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
          end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)),
        });
      }
    }
    const overallStart = new Date(
      Math.min(...[...monthRanges.values()].map((r) => r.start.getTime())),
    );
    const overallEnd = new Date(
      Math.max(...[...monthRanges.values()].map((r) => r.end.getTime())),
    );

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

    const existingRows = await this.prisma.teacher_saturday_schedules.findMany({
      where: {
        employee_id: { in: dto.employeeIds },
        date: { gte: overallStart, lte: overallEnd },
      },
      select: { employee_id: true, date: true },
    });

    // Running per-employee-per-month counts (seeded from the DB, incremented as
    // rows are created below) and a set of dates each employee is already on —
    // both scoped by month so a request spanning two payroll months enforces the
    // monthly cap independently per month rather than across the whole batch.
    const monthCountMap = new Map<string, number>();
    const alreadyScheduled = new Set<string>();
    for (const row of existingRows) {
      const monthKey = `${row.date.getUTCFullYear()}-${row.date.getUTCMonth()}`;
      const countKey = `${row.employee_id}:${monthKey}`;
      monthCountMap.set(countKey, (monthCountMap.get(countKey) ?? 0) + 1);
      alreadyScheduled.add(`${row.employee_id}:${this.dateKey(row.date)}`);
    }

    // An employee over the monthly cap for a given month is skipped for that
    // month's dates, not fatal to the whole batch — everything else still goes through.
    const cappedEmployeeIds = new Set<number>();
    const skippedCap: { employee_id: number; full_name: string | null }[] = [];
    const created: Prisma.teacher_saturday_schedulesGetPayload<{
      include: typeof scheduleInclude;
    }>[] = [];

    for (const date of uniqueDates) {
      const monthKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
      const dateKey = this.dateKey(date);

      for (const employee of employees) {
        const scheduledKey = `${employee.id}:${dateKey}`;
        if (alreadyScheduled.has(scheduledKey)) continue;

        const countKey = `${employee.id}:${monthKey}`;
        const count = monthCountMap.get(countKey) ?? 0;
        if (count >= MONTHLY_SATURDAY_CAP) {
          cappedEmployeeIds.add(employee.id);
          skippedCap.push({
            employee_id: employee.id,
            full_name: employee.full_name,
          });
          continue;
        }

        try {
          const row = await this.prisma.teacher_saturday_schedules.create({
            data: {
              employee_id: employee.id,
              date,
              marked_by: user.sub,
            },
            include: scheduleInclude,
          });
          created.push(row);
          monthCountMap.set(countKey, count + 1);
          alreadyScheduled.add(scheduledKey);
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            continue;
          }
          throw err;
        }
      }
    }

    // A mandatory Saturday always overrides an employee-scoped STAFF HOLIDAY
    // calendar entry for the same date (see CalendarDayResolverService) — flag
    // it so the admin knows the holiday will be ignored for that employee now,
    // instead of that happening silently.
    const holidayConflicts: {
      employee_id: number;
      full_name: string | null;
    }[] = [];
    const conflictDatesByEmployee = new Map<number, Date[]>();
    if (created.length > 0) {
      const conflictRows = await this.prisma.academic_calendar_days.findMany({
        where: {
          applies_to: 'STAFF',
          day_type: 'HOLIDAY',
          OR: created.map((r) => ({
            employee_id: r.employee_id,
            date: r.date,
          })),
        },
        select: { employee_id: true, date: true },
      });
      const conflictKeySet = new Set(
        conflictRows.map((r) => `${r.employee_id}:${this.dateKey(r.date)}`),
      );
      for (const row of created) {
        if (
          conflictKeySet.has(`${row.employee_id}:${this.dateKey(row.date)}`)
        ) {
          const bucket = conflictDatesByEmployee.get(row.employee_id) ?? [];
          bucket.push(row.date);
          conflictDatesByEmployee.set(row.employee_id, bucket);
        }
      }
      for (const employeeId of conflictDatesByEmployee.keys()) {
        const row = created.find((r) => r.employee_id === employeeId);
        holidayConflicts.push({
          employee_id: employeeId,
          full_name: row?.employee_profiles.full_name ?? null,
        });
      }
    }

    for (const [monthKey, range] of monthRanges) {
      const createdInMonth = created.filter(
        (row) =>
          `${row.date.getUTCFullYear()}-${row.date.getUTCMonth()}` === monthKey,
      );
      if (createdInMonth.length === 0) continue;

      const monthLabel = this.formatMonthLabel(range.start);
      const affectedCampusIds = new Set<number>();
      for (const row of createdInMonth) {
        if (row.employee_profiles.campus_id != null)
          affectedCampusIds.add(row.employee_profiles.campus_id);
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
          .catch((err) =>
            console.error(
              '[SaturdaySchedules] Notice board post failed:',
              err?.message,
            ),
          );
      }

      const employeeIdsInMonth = [
        ...new Set(createdInMonth.map((row) => row.employee_id)),
      ];
      void this.notifyEmployeesMonthlySummary(
        employeeIdsInMonth,
        range.start,
        range.end,
        range.start,
      ).catch((err) =>
        console.error(
          '[SaturdaySchedules] Monthly summary notice failed:',
          err?.message,
        ),
      );
    }

    if (holidayConflicts.length > 0) {
      const createdById = new Map(created.map((row) => [row.employee_id, row]));
      for (const conflict of holidayConflicts) {
        const userId = createdById.get(conflict.employee_id)?.employee_profiles
          .user_id;
        if (!userId) continue;
        const conflictDates =
          conflictDatesByEmployee.get(conflict.employee_id) ?? [];
        const conflictDateLabel = this.formatSaturdayList(conflictDates);
        void this.noticeBoard
          .createScheduleNotice(
            conflict.employee_id,
            userId,
            'Attendance Required Despite Day Off',
            `You have a day off marked for ${conflictDateLabel}, but a mandatory Saturday assignment takes priority — please check in as usual.`,
          )
          .catch((err) =>
            console.error(
              '[SaturdaySchedules] Conflict notice failed:',
              err?.message,
            ),
          );
      }
    }

    if (created.length > 0) {
      const createdByDate = new Map<string, typeof created>();
      for (const row of created) {
        const key = this.dateKey(row.date);
        const bucket = createdByDate.get(key) ?? [];
        bucket.push(row);
        createdByDate.set(key, bucket);
      }
      for (const [dateKey, rows] of createdByDate) {
        const employeeNames = rows
          .map(
            (row) =>
              row.employee_profiles.full_name ??
              `Employee #${row.employee_profiles.id}`,
          )
          .join(', ');
        void this.auditLogs.log({
          entity_type: 'SATURDAY_SCHEDULE',
          entity_id: dateKey,
          action: 'CREATED',
          changed_by: auditActorLabel(user),
          note: `Assigned mandatory Saturday ${dateKey} to ${rows.length} employee(s): ${employeeNames}.`,
        });
      }
    }

    // De-dupe skipped_cap entries — an employee capped out mid-batch across
    // multiple dates would otherwise appear once per date they were skipped for.
    const dedupedSkippedCap = [
      ...new Map(skippedCap.map((s) => [s.employee_id, s])).values(),
    ];

    return {
      created,
      skipped_cap: dedupedSkippedCap,
      holiday_conflicts: holidayConflicts,
    };
  }

  async list(query: ListSaturdaySchedulesQueryDto, user: IJwtStaffPayload) {
    this.assertCanManage(user);

    const [year, month] = query.month.split('-').map((v) => parseInt(v, 10));
    if (!year || !month || month < 1 || month > 12) {
      throw new BadRequestException('month must be YYYY-MM');
    }

    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0));

    const campusIds = query.campusId?.length
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
      ...(Object.keys(employeeFilter).length > 0
        ? { employee_profiles: employeeFilter }
        : {}),
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
      include: {
        employee_profiles: {
          select: { campus_id: true, full_name: true, user_id: true },
        },
      },
    });
    if (!existing) throw new NotFoundException('Saturday schedule not found');

    this.assertCampusAccess(user, existing.employee_profiles.campus_id);
    await this.prisma.teacher_saturday_schedules.delete({ where: { id } });

    void this.auditLogs.log({
      entity_type: 'SATURDAY_SCHEDULE',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: auditActorLabel(user),
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
        .catch((err) =>
          console.error(
            '[SaturdaySchedules] Removal notice failed:',
            err?.message,
          ),
        );
    }

    return { id };
  }

  private assertCanManage(user: IJwtStaffPayload) {
    if (
      user.role !== StaffRole.SUPER_ADMIN &&
      user.role !== StaffRole.CAMPUS_ADMIN
    ) {
      throw new ForbiddenException(
        'Only super admins and campus admins can manage Saturday schedules',
      );
    }
  }

  private assertCampusAccess(
    user: IJwtStaffPayload,
    employeeCampusId: number | null,
  ) {
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
    if (Number.isNaN(d.getTime()))
      throw new BadRequestException('Invalid date');
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
        if (await isTemplateDisabled(this.prisma, 'notif_staff_saturday_title'))
          return;

        const vars = {
          month: monthLabel,
          date_list: dateList,
          attendance_note: attendanceNote,
        };
        const title = await resolveTemplate(
          this.prisma,
          'notif_staff_saturday_title',
          'Working Saturday Notice',
          vars,
        );
        const body = await resolveTemplate(
          this.prisma,
          'notif_staff_saturday_body',
          'You are required to attend school on the following Saturday(s) in {month}: {date_list}. {attendance_note}',
          vars,
        );

        await this.fcmService.sendToUsers([userId], title, body, {
          type: 'EMPLOYEE_NOTICE',
        });
      }),
    );
  }
}
