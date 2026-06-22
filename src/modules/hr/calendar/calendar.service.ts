import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { isWeekendDate, parseCalendarDateKey } from './student-calendar-day.util';
import { HolidayAttendanceSyncService } from './holiday-attendance-sync.service';
import { CalendarNotificationService } from './calendar-notification.service';

import { IsInt, IsDateString, IsString, IsOptional, IsIn } from 'class-validator';
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
}

export class SyncCalendarAttendanceDto {
  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @IsDateString()
  date: string;

  @IsOptional()
  force?: boolean;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly holidaySync: HolidayAttendanceSyncService,
    private readonly notificationService: CalendarNotificationService,
  ) {}

  async findAll(campusId: number, appliesTo?: string) {
    return this.prisma.academic_calendar_days.findMany({
      where: {
        campus_id: campusId,
        ...(appliesTo ? { applies_to: appliesTo } : {}),
      },
      include: {
        classes: { select: { id: true, description: true, class_code: true } },
        sections: { select: { id: true, description: true } },
        departments: { select: { id: true, name: true } },
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
    return this.holidaySync.syncCampusForDate(dto.campus_id, date, { force: dto.force ?? false });
  }

  private validateScope(dto: CreateCalendarDayDto) {
    if (dto.section_id != null && dto.class_id == null) {
      throw new BadRequestException('section_id requires class_id');
    }
    if (dto.applies_to === 'STUDENT' && (dto.department_id != null || dto.employee_id != null)) {
      throw new BadRequestException('department_id and employee_id are only valid for STAFF calendar entries');
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
      employee_id: dto.employee_id ?? null,
    };
  }

  private dateKeyFromRow(row: { date: Date }): string {
    return row.date.toISOString().slice(0, 10);
  }

  async create(dto: CreateCalendarDayDto, createdBy?: string) {
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
        employee: { select: { id: true, full_name: true, employee_code: true } },
      },
    });

    await this.holidaySync.syncAfterCalendarChange(day.campus_id, dto.date);

    if (day.applies_to === 'STUDENT') {
      if (day.day_type === 'HOLIDAY') {
        await this.notificationService.notifyFamiliesForCalendarDay(day);
      } else if (day.day_type === 'WORKDAY' && isWeekendDate(day.date)) {
        await this.notificationService.notifySchoolOpenForCalendarDay(day);
      }
    }

    return day;
  }

  async update(id: number, dto: Partial<CreateCalendarDayDto>) {
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
        employee_id: dto.employee_id !== undefined ? dto.employee_id : undefined,
      },
      include: {
        classes: { select: { id: true, description: true, class_code: true } },
        sections: { select: { id: true, description: true } },
        departments: { select: { id: true, name: true } },
        employee: { select: { id: true, full_name: true, employee_code: true } },
      },
    });

    await this.holidaySync.syncAfterCalendarChange(day.campus_id, merged.date);

    if (day.applies_to === 'STUDENT') {
      if (day.day_type === 'HOLIDAY') {
        await this.notificationService.notifyFamiliesForCalendarDay(day);
      } else if (day.day_type === 'WORKDAY' && isWeekendDate(day.date)) {
        await this.notificationService.notifySchoolOpenForCalendarDay(day);
      }
    }

    return day;
  }

  async remove(id: number) {
    const existing = await this.findOne(id);
    const campusId = existing.campus_id;
    const dateKey = this.dateKeyFromRow(existing);

    const deleted = await this.prisma.academic_calendar_days.delete({
      where: { id },
    });

    await this.holidaySync.syncAfterCalendarChange(campusId, dateKey);
    return deleted;
  }
}
