import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { isWeekendDate, parseCalendarDateKey } from './student-calendar-day.util';

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
}

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(campusId: number, appliesTo?: string) {
    return this.prisma.academic_calendar_days.findMany({
      where: { 
        campus_id: campusId,
        ...(appliesTo ? { applies_to: appliesTo } : {})
      },
      orderBy: { date: 'asc' }
    });
  }

  async findOne(id: number) {
    const day = await this.prisma.academic_calendar_days.findUnique({
      where: { id }
    });
    if (!day) {
      throw new NotFoundException(`Calendar day with ID ${id} not found`);
    }
    return day;
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

  async create(dto: CreateCalendarDayDto) {
    this.validateStudentDayType(dto);

    return this.prisma.academic_calendar_days.create({
      data: {
        campus_id: dto.campus_id,
        date: new Date(dto.date),
        day_type: dto.day_type,
        description: dto.description || null,
        applies_to: dto.applies_to
      }
    });
  }

  async update(id: number, dto: Partial<CreateCalendarDayDto>) {
    const existing = await this.findOne(id);
    const merged: CreateCalendarDayDto = {
      campus_id: dto.campus_id ?? existing.campus_id,
      date: dto.date ?? existing.date.toISOString().slice(0, 10),
      day_type: dto.day_type ?? existing.day_type,
      description: dto.description ?? existing.description ?? undefined,
      applies_to: dto.applies_to ?? existing.applies_to,
    };
    this.validateStudentDayType(merged);

    return this.prisma.academic_calendar_days.update({
      where: { id },
      data: {
        campus_id: dto.campus_id,
        date: dto.date ? new Date(dto.date) : undefined,
        day_type: dto.day_type,
        description: dto.description,
        applies_to: dto.applies_to
      }
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.academic_calendar_days.delete({
      where: { id }
    });
  }
}
