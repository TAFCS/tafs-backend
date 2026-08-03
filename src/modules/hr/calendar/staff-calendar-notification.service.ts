import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { CalendarDayResolverService } from './calendar-day-resolver.service';
import { EmployeeNoticeBoardService } from '../../employee-notice-board/employee-notice-board.service';

function formatDatePKT(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Karachi',
  }).format(date);
}

interface StaffCalendarDayLike {
  campus_id: number;
  date: Date;
  applies_to: string;
  day_type: string;
  description: string | null;
  department_id: number | null;
  staff_category_id: number | null;
  employee_id: number | null;
}

type CandidateEmployee = {
  id: number;
  user_id: string | null;
  department_id: number | null;
  staff_category_id: number | null;
  staff_categories: { code: string | null } | null;
  days_per_week: number | null;
  employee_work_schedules: { day_of_week: number; is_working: boolean }[];
};

const candidateSelect = {
  id: true,
  user_id: true,
  department_id: true,
  staff_category_id: true,
  staff_categories: { select: { code: true } },
  days_per_week: true,
  employee_work_schedules: { select: { day_of_week: true, is_working: true } },
} as const;

/**
 * Notifies individual staff (via EmployeeNoticeBoardService's personal-post +
 * FCM channel) when an admin's STAFF calendar override or mandatory-Saturday
 * assignment actually changes what they see on their app calendar. Every
 * check re-resolves the day through CalendarDayResolverService rather than
 * trusting the row being written, since a broader-scoped row (e.g.
 * department-wide) can be shadowed by a more specific one for some of its
 * nominal targets — only employees for whom the change is actually the
 * winning entry get notified.
 */
@Injectable()
export class StaffCalendarNotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly noticeBoard: EmployeeNoticeBoardService,
  ) {}

  private async candidateEmployees(day: StaffCalendarDayLike): Promise<CandidateEmployee[]> {
    if (day.employee_id != null) {
      const emp = await this.prisma.employee_profiles.findUnique({
        where: { id: day.employee_id },
        select: candidateSelect,
      });
      return emp?.user_id ? [emp] : [];
    }

    const rows = await this.prisma.employee_profiles.findMany({
      where: {
        campus_id: day.campus_id,
        users: { is_active: true, deleted_at: null },
        ...(day.department_id != null ? { department_id: day.department_id } : {}),
        ...(day.staff_category_id != null ? { staff_category_id: day.staff_category_id } : {}),
      },
      select: candidateSelect,
    });
    return rows.filter((r) => r.user_id != null);
  }

  /**
   * Call after a STAFF academic_calendar_days row is created, updated, or removed.
   * `previousDayType` is the row's day_type before this change (undefined on create),
   * used to tell whether a removal/change is actually cancelling a day off.
   */
  async notifyForCalendarChange(
    day: StaffCalendarDayLike,
    changeType: 'CREATED' | 'UPDATED' | 'REMOVED',
    previousDayType?: string,
  ): Promise<void> {
    if (day.applies_to !== 'STAFF') return;

    const candidates = await this.candidateEmployees(day);
    if (candidates.length === 0) return;

    const rows = await this.calendarResolver.loadStaffCalendarRows(day.campus_id, day.date, day.date);
    const mandatorySaturdayMap =
      day.date.getUTCDay() === 6
        ? await this.calendarResolver.loadMandatorySaturdayDatesForEmployees(
            candidates.map((c) => c.id),
            day.date,
            day.date,
          )
        : new Map<number, Set<string>>();

    const formattedDate = formatDatePKT(day.date);

    for (const emp of candidates) {
      if (!emp.user_id) continue;
      const resolved = this.calendarResolver.resolveStaffDayFromRows(
        rows,
        day.date,
        emp.id,
        emp.department_id,
        emp.staff_category_id,
        emp.staff_categories?.code ?? null,
        emp.days_per_week,
        emp.employee_work_schedules,
        mandatorySaturdayMap.get(emp.id),
      );

      if (changeType !== 'REMOVED') {
        if (day.day_type === 'HOLIDAY' && !resolved.isWorkingDay && resolved.dayType === 'HOLIDAY') {
          const desc = resolved.description ?? day.description ?? 'Holiday';
          await this.noticeBoard.createScheduleNotice(
            emp.id,
            emp.user_id,
            'Day Off Marked',
            `You're marked off on ${formattedDate} for ${desc}. Your attendance will show as Excused — no action needed.`,
          );
        } else if (day.day_type === 'WORKDAY' && resolved.isWorkingDay) {
          const desc = day.description ?? 'a working day override';
          await this.noticeBoard.createScheduleNotice(
            emp.id,
            emp.user_id,
            'Working Day Notice',
            `You're required to attend on ${formattedDate} (${desc}) — this day has been changed to a working day.`,
          );
        }
      } else if (previousDayType === 'HOLIDAY' && resolved.isWorkingDay) {
        await this.noticeBoard.createScheduleNotice(
          emp.id,
          emp.user_id,
          'Day Off Cancelled',
          `The day off on ${formattedDate} has been cancelled — you're now expected to attend as normal.`,
        );
      }
    }
  }

  /** A mandatory Saturday always wins over an employee-scoped HOLIDAY calendar entry for
   *  the same date — let the employee know they still need to attend, from whichever
   *  side (calendar override or Saturday assignment) was created second. */
  async notifySaturdayConflict(employeeId: number, date: Date): Promise<void> {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { user_id: true },
    });
    if (!employee?.user_id) return;

    const formattedDate = formatDatePKT(date);
    await this.noticeBoard.createScheduleNotice(
      employeeId,
      employee.user_id,
      'Attendance Required Despite Day Off',
      `You have a day off marked for ${formattedDate}, but a mandatory Saturday assignment takes priority — please check in as usual.`,
    );
  }
}
