import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { isWeekendDate, isSaturdayDate, parseCalendarDateKey } from './student-calendar-day.util';
import { HolidayAttendanceSyncService } from './holiday-attendance-sync.service';
import { CalendarNotificationService } from './calendar-notification.service';
import { StaffCalendarNotificationService } from './staff-calendar-notification.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';

import { IsInt, IsDateString, IsString, IsOptional, IsIn, IsArray, ArrayMinSize, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCalendarDayDto {
  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @IsDateString()
  date: string;

  @IsString()
  @IsIn(['WORKDAY', 'HOLIDAY', 'WEEKEND'])
  day_type: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @IsIn(['STUDENT', 'STAFF'])
  applies_to: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  class_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  section_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  department_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employee_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  staff_category_id?: number;
}

export class CreateBulkCalendarDayDto {
  @IsDateString()
  date: string;

  @IsString()
  @IsIn(['WORKDAY', 'HOLIDAY', 'WEEKEND'])
  day_type: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @IsIn(['STUDENT', 'STAFF'])
  applies_to: string;
}

export class CreateEmployeeCalendarDaysDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Type(() => Number)
  employee_ids: number[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(90)
  @IsDateString({}, { each: true })
  dates: string[];

  @IsString()
  @IsIn(['WORKDAY', 'HOLIDAY'])
  day_type: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export interface EmployeeCalendarDaysResult {
  employees_total: number;
  dates_total: number;
  created: number;
  skipped: number;
  failed: number;
  errors: { employee_id: number; date: string; message: string }[];
  /** Saturday-scoped HOLIDAY entries created for an employee who already has a
   *  mandatory Saturday schedule for that date — the mandatory Saturday wins,
   *  so the holiday will have no effect for them on that date. */
  conflicts: { employee_id: number; date: string; message: string }[];
  /** (campus_id, date) pairs whose attendance re-sync failed after this change —
   *  the calendar rows were still saved, but EXCUSED attendance may be stale. */
  sync_failed: { campus_id: number; date: string }[];
}

export class SyncCalendarAttendanceDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campus_id?: number;

  @IsDateString()
  date: string;

  @IsOptional()
  force?: boolean;

  @IsOptional()
  all_campuses?: boolean;
}

export interface BulkCalendarCreateResult {
  campuses_total: number;
  created: number;
  skipped: number;
  failed: number;
  errors: { campus_id: number; message: string }[];
  /** Campuses where the calendar row saved but the attendance re-sync failed. */
  sync_failed: number;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly holidaySync: HolidayAttendanceSyncService,
    private readonly notificationService: CalendarNotificationService,
    private readonly staffNotificationService: StaffCalendarNotificationService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll(campusId?: number, appliesTo?: string, employeeId?: number) {
    if (campusId == null && employeeId == null) {
      throw new BadRequestException('campusId or employeeId is required');
    }
    return this.prisma.academic_calendar_days.findMany({
      where: {
        ...(campusId != null ? { campus_id: campusId } : {}),
        ...(appliesTo ? { applies_to: appliesTo } : {}),
        ...(employeeId != null ? { employee_id: employeeId } : {}),
      },
      include: {
        classes: { select: { id: true, description: true, class_code: true } },
        sections: { select: { id: true, description: true } },
        departments: { select: { id: true, name: true } },
        staff_categories: { select: { id: true, code: true, name: true, department_id: true } },
        employee: { select: { id: true, full_name: true, employee_code: true } },
      },
      orderBy: { date: 'asc' },
    });
  }

  async findOne(id: number) {
    const day = await this.prisma.academic_calendar_days.findUnique({
      where: { id },
      include: {
        classes: { select: { id: true, description: true, class_code: true } },
        sections: { select: { id: true, description: true } },
        departments: { select: { id: true, name: true } },
        staff_categories: { select: { id: true, code: true, name: true, department_id: true } },
        employee: { select: { id: true, full_name: true, employee_code: true } },
      },
    });
    if (!day) {
      throw new NotFoundException(`Calendar day with ID ${id} not found`);
    }
    return day;
  }

  async syncAttendance(dto: SyncCalendarAttendanceDto) {
    const date = this.holidaySync.parseDateKey(dto.date);
    const force = dto.force ?? false;

    if (dto.all_campuses) {
      return this.holidaySync.syncAllCampusesForDate(date, { force });
    }

    if (dto.campus_id == null) {
      throw new BadRequestException('campus_id is required unless all_campuses is true');
    }

    return this.holidaySync.syncCampusForDate(dto.campus_id, date, { force });
  }

  private validateScope(dto: CreateCalendarDayDto) {
    if (dto.section_id != null && dto.class_id == null) {
      throw new BadRequestException('section_id requires class_id');
    }
    if (dto.applies_to === 'STUDENT' && (dto.department_id != null || dto.employee_id != null || dto.staff_category_id != null)) {
      throw new BadRequestException('department_id, staff_category_id, and employee_id are only valid for STAFF calendar entries');
    }
    if (dto.applies_to === 'STAFF' && (dto.class_id != null || dto.section_id != null)) {
      throw new BadRequestException('class_id and section_id are only valid for STUDENT calendar entries');
    }
  }

  private validateStudentDayType(dto: CreateCalendarDayDto) {
    if (dto.applies_to !== 'STUDENT') return;

    const date = parseCalendarDateKey(dto.date);

    if (dto.day_type === 'WORKDAY' && !isWeekendDate(date)) {
      throw new BadRequestException(
        'Student WORKDAY overrides are only for Saturdays and Sundays (turn a weekend back on).',
      );
    }

    if (dto.day_type === 'WEEKEND') {
      throw new BadRequestException(
        'Student weekends are off by default. Use HOLIDAY for named holidays or WORKDAY to open a weekend.',
      );
    }
  }

  private scopeWhere(dto: CreateCalendarDayDto) {
    return {
      campus_id: dto.campus_id,
      date: new Date(dto.date),
      applies_to: dto.applies_to,
      class_id: dto.class_id ?? null,
      section_id: dto.section_id ?? null,
      department_id: dto.department_id ?? null,
      staff_category_id: dto.staff_category_id ?? null,
      employee_id: dto.employee_id ?? null,
    };
  }

  private dateKeyFromRow(row: { date: Date }): string {
    return row.date.toISOString().slice(0, 10);
  }

  /**
   * A Saturday-scoped STAFF HOLIDAY entry for a specific employee has no effect
   * if that employee already has a mandatory Saturday schedule for the same date —
   * applyMandatorySaturday() in the resolver always wins. Surface that instead of
   * letting the override silently do nothing.
   */
  private async checkSaturdayConflict(day: {
    applies_to: string;
    day_type: string;
    employee_id: number | null;
    date: Date;
  }): Promise<string | null> {
    if (day.applies_to !== 'STAFF' || day.day_type !== 'HOLIDAY' || day.employee_id == null) return null;
    if (!isSaturdayDate(day.date)) return null;

    const mandatory = await this.prisma.teacher_saturday_schedules.findUnique({
      where: { employee_id_date: { employee_id: day.employee_id, date: day.date } },
    });
    if (!mandatory) return null;

    return 'This employee has a mandatory Saturday schedule for this date, which takes priority — this holiday will have no effect unless the mandatory Saturday is removed first.';
  }

  async create(
    dto: CreateCalendarDayDto,
    createdBy?: string,
    changedBy?: string,
    options?: { skipSync?: boolean },
  ) {
    this.validateScope(dto);
    this.validateStudentDayType(dto);

    const existing = await this.prisma.academic_calendar_days.findFirst({
      where: this.scopeWhere(dto),
    });
    if (existing) {
      throw new BadRequestException('A calendar entry with the same scope already exists for this date');
    }

    const day = await this.prisma.academic_calendar_days.create({
      data: {
        ...this.scopeWhere(dto),
        day_type: dto.day_type,
        description: dto.description || null,
        created_by: createdBy ?? null,
      },
      include: {
        classes: { select: { id: true, description: true, class_code: true } },
        sections: { select: { id: true, description: true } },
        departments: { select: { id: true, name: true } },
        staff_categories: { select: { id: true, code: true, name: true } },
        employee: { select: { id: true, full_name: true, employee_code: true } },
      },
    });

    let syncWarning: string | null = null;
    if (!options?.skipSync) {
      const syncResult = await this.holidaySync.syncAfterCalendarChange(day.campus_id, dto.date);
      if (syncResult === null) {
        syncWarning = 'Calendar entry saved, but the attendance re-sync failed — use "Apply holiday attendance manually" to retry.';
      }
    }
    const conflictWarning = await this.checkSaturdayConflict(day);

    if (day.applies_to === 'STUDENT') {
      if (day.day_type === 'HOLIDAY') {
        await this.notificationService.notifyFamiliesForCalendarDay(day);
      } else if (day.day_type === 'WORKDAY' && isWeekendDate(day.date)) {
        await this.notificationService.notifySchoolOpenForCalendarDay(day);
      }
    } else if (day.applies_to === 'STAFF') {
      void this.staffNotificationService
        .notifyForCalendarChange(day, 'CREATED')
        .catch((err) => console.error('[Calendar] Staff notice (created) failed:', err?.message));
      if (conflictWarning && day.employee_id != null) {
        void this.staffNotificationService
          .notifySaturdayConflict(day.employee_id, day.date)
          .catch((err) => console.error('[Calendar] Staff conflict notice failed:', err?.message));
      }
    }

    void this.auditLogs.log({
      entity_type: 'ACADEMIC_CALENDAR_DAY',
      entity_id: String(day.id),
      action: 'CREATED',
      changed_by: changedBy ?? createdBy ?? 'system',
      note: `${day.day_type} on ${this.dateKeyFromRow(day)} for ${day.applies_to}, campus #${day.campus_id}.${day.description ? ` ${day.description}` : ''}`,
    });

    return { ...day, sync_warning: syncWarning, conflict_warning: conflictWarning };
  }

  async createBulk(dto: CreateBulkCalendarDayDto, createdBy?: string, changedBy?: string): Promise<BulkCalendarCreateResult> {
    const template: Omit<CreateCalendarDayDto, 'campus_id'> = {
      date: dto.date,
      day_type: dto.day_type,
      description: dto.description,
      applies_to: dto.applies_to,
    };
    this.validateStudentDayType({ ...template, campus_id: 0 });

    const campuses = await this.prisma.campuses.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    const result: BulkCalendarCreateResult = {
      campuses_total: campuses.length,
      created: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      sync_failed: 0,
    };

    for (const campus of campuses) {
      try {
        const day = await this.create({ ...template, campus_id: campus.id }, createdBy, changedBy);
        result.created++;
        if (day.sync_warning) result.sync_failed++;
      } catch (err) {
        const message = err instanceof BadRequestException ? String(err.message) : (err as Error).message;
        if (message.includes('same scope already exists')) {
          result.skipped++;
        } else {
          result.failed++;
          result.errors.push({ campus_id: campus.id, message });
        }
      }
    }

    if (result.created === 0 && result.failed > 0) {
      throw new BadRequestException(
        `Failed to create calendar entry on all campuses (${result.failed} failed, ${result.skipped} skipped).`,
      );
    }

    return result;
  }

  /**
   * Per-employee day override (e.g. a one-off holiday for specific staff) —
   * `employee_id` scope already outranks every other STAFF calendar scope
   * (campus/department/staff_category) in CalendarDayResolverService's
   * specificity ranking, so this always wins for the employees it targets.
   */
  async createForEmployees(
    dto: CreateEmployeeCalendarDaysDto,
    createdBy?: string,
    changedBy?: string,
  ): Promise<EmployeeCalendarDaysResult> {
    const uniqueEmployeeIds = [...new Set(dto.employee_ids)];
    const employees = await this.prisma.employee_profiles.findMany({
      where: { id: { in: uniqueEmployeeIds } },
      select: { id: true, full_name: true, campus_id: true },
    });
    if (employees.length !== uniqueEmployeeIds.length) {
      throw new BadRequestException('One or more employee IDs were not found');
    }

    const uniqueDates = [...new Set(dto.dates)];
    const result: EmployeeCalendarDaysResult = {
      employees_total: employees.length,
      dates_total: uniqueDates.length,
      created: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      conflicts: [],
      sync_failed: [],
    };

    // Employees with no campus assigned can't get a campus-scoped calendar row —
    // skip just them (one failed entry per date) instead of aborting the whole
    // batch, so the rest of the selection still gets processed.
    const missingCampus = employees.filter((e) => e.campus_id == null);
    for (const employee of missingCampus) {
      for (const date of uniqueDates) {
        result.failed++;
        result.errors.push({
          employee_id: employee.id,
          date,
          message: `${employee.full_name ?? `Employee #${employee.id}`} has no campus assigned`,
        });
      }
    }
    const eligibleEmployees = employees.filter((e) => e.campus_id != null);

    // syncAfterCalendarChange rescans the whole campus for a given date and doesn't
    // depend on which employee triggered the change, so it's deduped to run once per
    // (campus_id, date) pair after the loop instead of once per employee — the naive
    // per-row version made this endpoint scale as employees × dates × campus roster size.
    const syncPairs = new Map<string, { campusId: number; date: string }>();

    for (const employee of eligibleEmployees) {
      for (const date of uniqueDates) {
        try {
          const day = await this.create(
            {
              campus_id: employee.campus_id!,
              date,
              day_type: dto.day_type,
              description: dto.description,
              applies_to: 'STAFF',
              employee_id: employee.id,
            },
            createdBy,
            changedBy,
            { skipSync: true },
          );
          result.created++;
          if (day.conflict_warning) {
            result.conflicts.push({ employee_id: employee.id, date, message: day.conflict_warning });
          }
          syncPairs.set(`${employee.campus_id}:${date}`, { campusId: employee.campus_id!, date });
        } catch (err) {
          const message = err instanceof BadRequestException ? String(err.message) : (err as Error).message;
          if (message.includes('same scope already exists')) {
            result.skipped++;
          } else {
            result.failed++;
            result.errors.push({ employee_id: employee.id, date, message });
          }
        }
      }
    }

    for (const { campusId, date } of syncPairs.values()) {
      const syncResult = await this.holidaySync.syncAfterCalendarChange(campusId, date);
      if (syncResult === null) {
        result.sync_failed.push({ campus_id: campusId, date });
      }
    }

    if (result.created === 0 && result.failed > 0) {
      throw new BadRequestException(
        `Failed to create any calendar override (${result.failed} failed, ${result.skipped} skipped).`,
      );
    }

    return result;
  }

  async update(id: number, dto: Partial<CreateCalendarDayDto>, changedBy: string) {
    const existing = await this.findOne(id);
    const merged: CreateCalendarDayDto = {
      campus_id: dto.campus_id ?? existing.campus_id,
      date: dto.date ?? existing.date.toISOString().slice(0, 10),
      day_type: dto.day_type ?? existing.day_type,
      description: dto.description ?? existing.description ?? undefined,
      applies_to: dto.applies_to ?? existing.applies_to,
      class_id: dto.class_id !== undefined ? dto.class_id : existing.class_id ?? undefined,
      section_id: dto.section_id !== undefined ? dto.section_id : existing.section_id ?? undefined,
      department_id:
        dto.department_id !== undefined ? dto.department_id : existing.department_id ?? undefined,
      employee_id: dto.employee_id !== undefined ? dto.employee_id : existing.employee_id ?? undefined,
      staff_category_id:
        dto.staff_category_id !== undefined ? dto.staff_category_id : existing.staff_category_id ?? undefined,
    };
    this.validateScope(merged);
    this.validateStudentDayType(merged);

    const duplicate = await this.prisma.academic_calendar_days.findFirst({
      where: { ...this.scopeWhere(merged), NOT: { id } },
    });
    if (duplicate) {
      throw new BadRequestException('A calendar entry with the same scope already exists for this date');
    }

    const day = await this.prisma.academic_calendar_days.update({
      where: { id },
      data: {
        campus_id: dto.campus_id,
        date: dto.date ? new Date(dto.date) : undefined,
        day_type: dto.day_type,
        description: dto.description,
        applies_to: dto.applies_to,
        class_id: dto.class_id !== undefined ? dto.class_id : undefined,
        section_id: dto.section_id !== undefined ? dto.section_id : undefined,
        department_id: dto.department_id !== undefined ? dto.department_id : undefined,
        staff_category_id: dto.staff_category_id !== undefined ? dto.staff_category_id : undefined,
        employee_id: dto.employee_id !== undefined ? dto.employee_id : undefined,
      },
      include: {
        classes: { select: { id: true, description: true, class_code: true } },
        sections: { select: { id: true, description: true } },
        departments: { select: { id: true, name: true } },
        staff_categories: { select: { id: true, code: true, name: true, department_id: true } },
        employee: { select: { id: true, full_name: true, employee_code: true } },
      },
    });

    const syncResult = await this.holidaySync.syncAfterCalendarChange(day.campus_id, merged.date);
    const syncWarning =
      syncResult === null
        ? 'Calendar entry updated, but the attendance re-sync failed — use "Apply holiday attendance manually" to retry.'
        : null;
    const conflictWarning = await this.checkSaturdayConflict(day);

    if (day.applies_to === 'STUDENT') {
      if (day.day_type === 'HOLIDAY') {
        await this.notificationService.notifyFamiliesForCalendarDay(day);
      } else if (day.day_type === 'WORKDAY' && isWeekendDate(day.date)) {
        await this.notificationService.notifySchoolOpenForCalendarDay(day);
      }
    } else if (day.applies_to === 'STAFF') {
      const dateChanged = this.dateKeyFromRow(day) !== this.dateKeyFromRow(existing);
      const onNotifyError = (err: any) => console.error('[Calendar] Staff notice (updated) failed:', err?.message);
      if (dateChanged) {
        // The old date is no longer covered by this entry — tell the same
        // audience it moved, then notify for the new date as a fresh change.
        void this.staffNotificationService
          .notifyForCalendarChange(existing, 'REMOVED', existing.day_type)
          .catch(onNotifyError);
        void this.staffNotificationService.notifyForCalendarChange(day, 'CREATED').catch(onNotifyError);
      } else {
        void this.staffNotificationService
          .notifyForCalendarChange(day, 'UPDATED', existing.day_type)
          .catch(onNotifyError);
      }
      if (conflictWarning && day.employee_id != null) {
        void this.staffNotificationService
          .notifySaturdayConflict(day.employee_id, day.date)
          .catch((err) => console.error('[Calendar] Staff conflict notice failed:', err?.message));
      }
    }

    const changes: string[] = [];
    if (dto.day_type !== undefined && dto.day_type !== existing.day_type) {
      changes.push(`Day Type: ${existing.day_type} → ${dto.day_type}`);
    }
    if (dto.date !== undefined) {
      const newDate = new Date(dto.date).toISOString().slice(0, 10);
      const oldDate = this.dateKeyFromRow(existing);
      if (newDate !== oldDate) changes.push(`Date: ${oldDate} → ${newDate}`);
    }
    if (dto.description !== undefined && dto.description !== existing.description) {
      changes.push(`Description: ${existing.description ?? '—'} → ${dto.description ?? '—'}`);
    }
    if (dto.applies_to !== undefined && dto.applies_to !== existing.applies_to) {
      changes.push(`Applies To: ${existing.applies_to} → ${dto.applies_to}`);
    }
    void this.auditLogs.log({
      entity_type: 'ACADEMIC_CALENDAR_DAY',
      entity_id: String(id),
      action: 'UPDATED',
      changed_by: changedBy,
      note: changes.length > 0 ? changes.join('; ') : 'No field changes detected.',
    });

    return { ...day, sync_warning: syncWarning, conflict_warning: conflictWarning };
  }

  async remove(id: number, changedBy: string) {
    const existing = await this.findOne(id);
    const campusId = existing.campus_id;
    const dateKey = this.dateKeyFromRow(existing);

    const deleted = await this.prisma.academic_calendar_days.delete({
      where: { id },
    });

    const syncResult = await this.holidaySync.syncAfterCalendarChange(campusId, dateKey);
    const syncWarning =
      syncResult === null
        ? 'Calendar entry deleted, but the attendance re-sync failed — use "Apply holiday attendance manually" to retry.'
        : null;

    if (existing.applies_to === 'STAFF') {
      void this.staffNotificationService
        .notifyForCalendarChange(existing, 'REMOVED', existing.day_type)
        .catch((err) => console.error('[Calendar] Staff notice (removed) failed:', err?.message));
    }

    void this.auditLogs.log({
      entity_type: 'ACADEMIC_CALENDAR_DAY',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: changedBy,
      note: `Deleted ${existing.day_type} on ${dateKey} for ${existing.applies_to}, campus #${campusId}.`,
    });

    return { ...deleted, sync_warning: syncWarning };
  }
}
