import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

const toTime = (value?: string) => (value ? new Date(`1970-01-01T${value}:00Z`) : null);

import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateClassScheduleDto {
  @IsInt()
  class_id: number;

  @IsInt()
  campus_id: number;

  @IsString()
  expected_check_in: string;

  @IsInt()
  @Min(0)
  late_grace_minutes: number;

  @IsDateString()
  effective_from: string;
}

export class UpdateClassScheduleDto {
  @IsOptional()
  @IsString()
  expected_check_in?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  late_grace_minutes?: number;

  @IsOptional()
  @IsDateString()
  effective_from?: string;
}

@Injectable()
export class ClassCheckInScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(campusId: number) {
    return this.prisma.class_check_in_schedules.findMany({
      where: { campus_id: campusId },
      include: {
        classes: { select: { id: true, description: true, class_code: true } },
      },
      orderBy: { effective_from: 'desc' },
    });
  }

  async findOne(id: number) {
    const schedule = await this.prisma.class_check_in_schedules.findUnique({
      where: { id },
      include: {
        classes: { select: { id: true, description: true, class_code: true } },
      },
    });
    if (!schedule) {
      throw new NotFoundException(`Check-in schedule with ID ${id} not found`);
    }
    return schedule;
  }

  async create(dto: CreateClassScheduleDto, createdBy?: string) {
    const effectiveFrom = new Date(dto.effective_from);
    effectiveFrom.setUTCHours(0, 0, 0, 0);

    const existing = await this.prisma.class_check_in_schedules.findUnique({
      where: {
        class_id_effective_from: {
          class_id: dto.class_id,
          effective_from: effectiveFrom,
        },
      },
    });
    if (existing) {
      throw new BadRequestException('A schedule for this class starting on this date already exists');
    }

    const time = toTime(dto.expected_check_in);
    if (!time) {
      throw new BadRequestException('Invalid expected_check_in format');
    }

    return this.prisma.class_check_in_schedules.create({
      data: {
        class_id: dto.class_id,
        campus_id: dto.campus_id,
        expected_check_in: time,
        late_grace_minutes: dto.late_grace_minutes,
        effective_from: effectiveFrom,
        created_by: createdBy ?? null,
      },
      include: {
        classes: { select: { id: true, description: true, class_code: true } },
      },
    });
  }

  async update(id: number, dto: UpdateClassScheduleDto) {
    const existing = await this.findOne(id);

    const data: any = {};
    if (dto.expected_check_in !== undefined) {
      const time = toTime(dto.expected_check_in);
      if (!time) {
        throw new BadRequestException('Invalid expected_check_in format');
      }
      data.expected_check_in = time;
    }
    if (dto.late_grace_minutes !== undefined) {
      data.late_grace_minutes = dto.late_grace_minutes;
    }
    if (dto.effective_from !== undefined) {
      const effectiveFrom = new Date(dto.effective_from);
      effectiveFrom.setUTCHours(0, 0, 0, 0);

      const duplicate = await this.prisma.class_check_in_schedules.findFirst({
        where: {
          class_id: existing.class_id,
          effective_from: effectiveFrom,
          NOT: { id },
        },
      });
      if (duplicate) {
        throw new BadRequestException('A schedule for this class starting on this date already exists');
      }
      data.effective_from = effectiveFrom;
    }

    return this.prisma.class_check_in_schedules.update({
      where: { id },
      data,
      include: {
        classes: { select: { id: true, description: true, class_code: true } },
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.class_check_in_schedules.delete({
      where: { id },
    });
  }
}
