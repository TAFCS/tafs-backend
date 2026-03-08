import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateClassFeeScheduleDto } from './dto/create-class-fee-schedule.dto';
import { BulkUpdateClassFeeScheduleDto } from './dto/bulk-update-class-fee-schedule.dto';

@Injectable()
export class ClassFeeScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.class_fee_schedule.findMany({
      include: {
        classes: true,
        fee_types: true,
        campuses: true,
      },
    });
  }

  async findByClassId(classId: number) {
    return this.prisma.class_fee_schedule.findMany({
      where: { class_id: classId },
      include: {
        classes: true,
        fee_types: true,
        campuses: true,
      },
    });
  }

  async create(dto: CreateClassFeeScheduleDto) {
    return this.prisma.class_fee_schedule.create({
      data: {
        class_id: dto.class_id,
        fee_id: dto.fee_id,
        amount: dto.amount,
        ...(dto.campus_id !== undefined && { campus_id: dto.campus_id }),
      },
      include: {
        classes: true,
        fee_types: true,
        campuses: true,
      },
    });
  }

  async bulkUpdate(dto: BulkUpdateClassFeeScheduleDto) {
    if (!dto.items || dto.items.length === 0) {
      return [];
    }

    const updated = await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.class_fee_schedule.update({
          where: { id: item.id },
          data: {
            ...(item.class_id !== undefined && { class_id: item.class_id }),
            ...(item.fee_id !== undefined && { fee_id: item.fee_id }),
            ...(item.amount !== undefined && { amount: item.amount }),
            ...(item.campus_id !== undefined && { campus_id: item.campus_id }),
          },
          include: {
            classes: true,
            fee_types: true,
            campuses: true,
          },
        }),
      ),
    );

    if (!updated || updated.length !== dto.items.length) {
      throw new NotFoundException('One or more class fee schedules not found');
    }

    return updated;
  }
}
