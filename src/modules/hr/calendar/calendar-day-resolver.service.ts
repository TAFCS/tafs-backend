import { Injectable } from '@nestjs/common';
import { academic_calendar_days } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { isWeekendDate } from './student-calendar-day.util';

export type CalendarDayType = 'WORKDAY' | 'HOLIDAY' | 'WEEKEND';

export interface ResolvedCalendarDay {
  isWorkingDay: boolean;
  dayType: CalendarDayType | null;
  description: string | null;
  source: 'CALENDAR' | 'SCHEDULE' | 'DEFAULT';
}

type CalendarRow = Pick<
  academic_calendar_days,
  'day_type' | 'description' | 'class_id' | 'section_id' | 'department_id' | 'employee_id'
>;

@Injectable()
export class CalendarDayResolverService {
  constructor(private readonly prisma: PrismaService) {}

  private calendarSpecificity(row: CalendarRow, audience: 'STUDENT' | 'STAFF'): number {
    if (audience === 'STAFF') {
      if (row.employee_id) return 4;
      if (row.department_id) return 3;
      return 1;
    }
    if (row.section_id) return 3;
    if (row.class_id) return 2;
    return 1;
  }

  private matchesStudentScope(row: CalendarRow, classId: number | null, sectionId: number | null): boolean {
    if (row.section_id != null) {
      return row.class_id === classId && row.section_id === sectionId;
    }
    if (row.class_id != null) {
      return row.class_id === classId;
    }
    return row.class_id == null && row.section_id == null;
  }

  private matchesStaffScope(
    row: CalendarRow,
    employeeId: number,
    departmentId: number | null,
  ): boolean {
    if (row.employee_id != null) return row.employee_id === employeeId;
    if (row.department_id != null) return row.department_id === departmentId;
    return row.employee_id == null && row.department_id == null;
  }

  private pickBestCalendarRow(rows: CalendarRow[], audience: 'STUDENT' | 'STAFF'): CalendarRow | null {
    if (rows.length === 0) return null;
    return rows.reduce((best, row) =>
      this.calendarSpecificity(row, audience) > this.calendarSpecificity(best, audience) ? row : best,
    );
  }

  private fromDayType(dayType: string, description: string | null): ResolvedCalendarDay {
    if (dayType === 'WORKDAY') {
      return { isWorkingDay: true, dayType: 'WORKDAY', description, source: 'CALENDAR' };
    }
    if (dayType === 'HOLIDAY') {
      return {
        isWorkingDay: false,
        dayType: 'HOLIDAY',
        description,
        source: 'CALENDAR',
      };
    }
    return {
      isWorkingDay: false,
      dayType: 'WEEKEND',
      description: description ?? 'Day Off',
      source: 'CALENDAR',
    };
  }

  private defaultStudentDay(date: Date): ResolvedCalendarDay {
    if (isWeekendDate(date)) {
      return {
        isWorkingDay: false,
        dayType: 'WEEKEND',
        description: 'Weekend',
        source: 'DEFAULT',
      };
    }
    return { isWorkingDay: true, dayType: null, description: null, source: 'DEFAULT' };
  }

  private isWorkingDayFromSchedule(dayOfWeek: number, daysPerWeek: number | null): boolean {
    // 0=Sun, 1=Mon ... 6=Sat (UTC)
    if (dayOfWeek === 0) return false;
    const weekDays = daysPerWeek === 6 ? 6 : 5;
    return dayOfWeek >= 1 && dayOfWeek <= weekDays;
  }

  async resolveStudentDay(
    campusId: number,
    classId: number | null,
    sectionId: number | null,
    date: Date,
  ): Promise<ResolvedCalendarDay> {
    const rows = await this.prisma.academic_calendar_days.findMany({
      where: {
        campus_id: campusId,
        date,
        applies_to: 'STUDENT',
      },
      select: {
        day_type: true,
        description: true,
        class_id: true,
        section_id: true,
        department_id: true,
        employee_id: true,
      },
    });

    const matching = rows.filter((row) => this.matchesStudentScope(row, classId, sectionId));
    const best = this.pickBestCalendarRow(matching, 'STUDENT');
    if (best) return this.fromDayType(best.day_type, best.description);

    return this.defaultStudentDay(date);
  }

  async resolveStaffDay(employeeId: number, campusId: number, date: Date): Promise<ResolvedCalendarDay> {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: {
        department_id: true,
        days_per_week: true,
        employee_work_schedules: { select: { day_of_week: true, is_working: true } },
      },
    });

    const dayOfWeek = date.getUTCDay();
    let scheduleWorking: boolean;

    if (employee?.employee_work_schedules.length) {
      const row = employee.employee_work_schedules.find((s) => s.day_of_week === dayOfWeek);
      scheduleWorking = row?.is_working ?? false;
    } else {
      scheduleWorking = this.isWorkingDayFromSchedule(dayOfWeek, employee?.days_per_week ?? 5);
    }

    const rows = await this.prisma.academic_calendar_days.findMany({
      where: {
        campus_id: campusId,
        date,
        applies_to: 'STAFF',
      },
      select: {
        day_type: true,
        description: true,
        class_id: true,
        section_id: true,
        department_id: true,
        employee_id: true,
      },
    });

    const matching = rows.filter((row) =>
      this.matchesStaffScope(row, employeeId, employee?.department_id ?? null),
    );
    const best = this.pickBestCalendarRow(matching, 'STAFF');
    if (best) return this.fromDayType(best.day_type, best.description);

    if (!scheduleWorking) {
      return {
        isWorkingDay: false,
        dayType: isWeekendDate(date) ? 'WEEKEND' : 'HOLIDAY',
        description: isWeekendDate(date) ? 'Weekend' : 'Scheduled day off',
        source: 'SCHEDULE',
      };
    }

    return { isWorkingDay: true, dayType: null, description: null, source: 'SCHEDULE' };
  }

  /** Batch-load calendar rows for a campus/date range (student display). */
  async loadStudentCalendarMap(
    campusId: number,
    classId: number | null,
    sectionId: number | null,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<Map<string, ResolvedCalendarDay>> {
    const rows = await this.prisma.academic_calendar_days.findMany({
      where: {
        campus_id: campusId,
        applies_to: 'STUDENT',
        date: { gte: dateFrom, lte: dateTo },
      },
      select: {
        date: true,
        day_type: true,
        description: true,
        class_id: true,
        section_id: true,
        department_id: true,
        employee_id: true,
      },
    });

    const byDate = new Map<string, CalendarRow[]>();
    for (const row of rows) {
      if (!this.matchesStudentScope(row, classId, sectionId)) continue;
      const key = row.date.toISOString().slice(0, 10);
      const bucket = byDate.get(key);
      if (bucket) bucket.push(row);
      else byDate.set(key, [row]);
    }

    const result = new Map<string, ResolvedCalendarDay>();
    for (let d = new Date(dateFrom); d <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      const dayRows = byDate.get(key) ?? [];
      const best = this.pickBestCalendarRow(dayRows, 'STUDENT');
      result.set(key, best ? this.fromDayType(best.day_type, best.description) : this.defaultStudentDay(new Date(d)));
    }
    return result;
  }

  toHolidayDisplay(resolved: ResolvedCalendarDay): {
    holiday_type: string | null;
    holiday_description: string | null;
  } {
    if (resolved.isWorkingDay) {
      return { holiday_type: null, holiday_description: null };
    }
    return {
      holiday_type: resolved.dayType ?? 'HOLIDAY',
      holiday_description: resolved.description,
    };
  }
}
