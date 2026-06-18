import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

import { IsInt, IsDateString, IsString, IsOptional } from 'class-validator';

export class CreateCalendarDayDto {
  @IsInt()
  campus_id: number;

  @IsDateString()
  date: string;

  @IsString()
  day_type: string;

  @IsOptional()
  @IsString()
  description?: string;
}

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(campusId: number) {
    return this.prisma.academic_calendar_days.findMany({
      where: { campus_id: campusId },
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

  async create(dto: CreateCalendarDayDto) {
    return this.prisma.academic_calendar_days.create({
      data: {
        campus_id: dto.campus_id,
        date: new Date(dto.date),
        day_type: dto.day_type,
        description: dto.description || null
      }
    });
  }

  async update(id: number, dto: Partial<CreateCalendarDayDto>) {
    await this.findOne(id);
    return this.prisma.academic_calendar_days.update({
      where: { id },
      data: {
        campus_id: dto.campus_id,
        date: dto.date ? new Date(dto.date) : undefined,
        day_type: dto.day_type,
        description: dto.description
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
