import { Injectable } from '@nestjs/common';
import { StaffCategory } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { isWeekendDate } from './student-calendar-day.util';

export type CalendarDayType = 'WORKDAY' | 'HOLIDAY' | 'WEEKEND';

export interface ResolvedCalendarDay {
  isWorkingDay: boolean;
  dayType: CalendarDayType | null;
  description: string | null;
  source: 'CALENDAR' | 'SCHEDULE' | 'DEFAULT';
}

type CalendarRow = {
  day_type: string;
  description: string | null;
  class_id: number | null;
  section_id: number | null;
  department_id: number | null;
  staff_category: StaffCategory | null;
  employee_id: number | null;
};

@Injectable()
export class CalendarDayResolverService {
  constructor(private readonly prisma: PrismaService) {}

  private calendarSpecificity(row: CalendarRow, audience: 'STUDENT' | 'STAFF'): number {
    if (audience === 'STAFF') {
      if (row.employee_id) return 5;
      if (row.department_id && row.staff_category) return 4;
      if (row.department_id) return 3;
      if (row.staff_category) return 2;
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
    staffCategory: StaffCategory | null,
  ): boolean {
    if (row.employee_id != null) return row.employee_id === employeeId;
    if (row.department_id != null && row.staff_category != null) {
      return row.department_id === departmentId && row.staff_category === staffCategory;
    }
    if (row.department_id != null) return row.department_id === departmentId;
    if (row.staff_category != null) return row.staff_category === staffCategory;
    return row.employee_id == null && row.department_id == null && row.staff_category == null;
  }

  private pickBestCalendarRow(rows: CalendarRow[], audience: 'STUDENT' | 'STAFF'): CalendarRow | null {
    if (rows.length === 0) return null;
    return rows.reduce((best, row) =>
      this.calendarSpecificity(row, audience) > this.calendarSpecificity(best, audience) ? row : best,
    );
  }

  private fromDayType(dayType: string, description: string | null): ResolvedCalendarDay {
    const cleanDesc = description?.startsWith('[PINNED] ') ? description.replace('[PINNED] ', '') : description;
    if (dayType === 'WORKDAY') {
      return { isWorkingDay: true, dayType: 'WORKDAY', description: cleanDesc, source: 'CALENDAR' };
    }
    if (dayType === 'HOLIDAY') {
      return {
        isWorkingDay: false,
        dayType: 'HOLIDAY',
        description: cleanDesc,
        source: 'CALENDAR',
      };
    }
    return {
      isWorkingDay: false,
      dayType: 'WEEKEND',
      description: cleanDesc ?? 'Day Off',
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
        staff_category: true,
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
        staff_category: true,
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
        staff_category: true,
        employee_id: true,
      },
    });

    const matching = rows.filter((row) =>
      this.matchesStaffScope(
        row,
        employeeId,
        employee?.department_id ?? null,
        employee?.staff_category ?? null,
      ),
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

  /**
   * Batched equivalent of resolveStaffDay() for running it over many
   * employees x many days (e.g. payroll generation) without one DB round
   * trip per employee per day. Callers load `rows` once via
   * loadStaffCalendarRows() and `workSchedules` once per employee, then call
   * this synchronously per day.
   */
  resolveStaffDayFromRows(
    rows: (CalendarRow & { date: Date })[],
    date: Date,
    employeeId: number,
    departmentId: number | null,
    staffCategory: StaffCategory | null,
    daysPerWeek: number | null,
    workSchedules: { day_of_week: number; is_working: boolean }[],
  ): ResolvedCalendarDay {
    const dayOfWeek = date.getUTCDay();
    const scheduleWorking = workSchedules.length
      ? workSchedules.find((s) => s.day_of_week === dayOfWeek)?.is_working ?? false
      : this.isWorkingDayFromSchedule(dayOfWeek, daysPerWeek ?? 5);

    const matching = rows.filter(
      (row) =>
        row.date.getTime() === date.getTime() &&
        this.matchesStaffScope(row, employeeId, departmentId, staffCategory),
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

  /** Loads the raw STAFF calendar rows for a campus/date range once, for resolveStaffDayFromRows(). */
  async loadStaffCalendarRows(campusId: number, dateFrom: Date, dateTo: Date): Promise<(CalendarRow & { date: Date })[]> {
    return this.prisma.academic_calendar_days.findMany({
      where: { campus_id: campusId, applies_to: 'STAFF', date: { gte: dateFrom, lte: dateTo } },
      select: {
        date: true,
        day_type: true,
        description: true,
        class_id: true,
        section_id: true,
        department_id: true,
        staff_category: true,
        employee_id: true,
      },
    });
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
        staff_category: true,
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
