import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateClassFeeScheduleDto } from './dto/create-class-fee-schedule.dto';
import { BulkUpdateClassFeeScheduleDto } from './dto/bulk-update-class-fee-schedule.dto';

@Injectable()
export class ClassFeeScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) { }

  async findAll(academicYear?: string) {
    return this.prisma.class_fee_schedule.findMany({
      where: {
        ...(academicYear && { academic_year: academicYear }),
      },
      include: {
        classes: true,
        fee_types: true,
        campuses: true,
      },
    });
  }

  async findByClassId(classId: number, campusId?: number) {
    return this.prisma.class_fee_schedule.findMany({
      where: {
        class_id: classId,
        ...(campusId !== undefined
          ? {
              OR: [{ campus_id: campusId }, { campus_id: null }],
            }
          : {}),
      },
      include: {
        classes: true,
        fee_types: true,
        campuses: true,
      },
    });
  }

  async create(dto: CreateClassFeeScheduleDto, changedBy?: string) {
    const record = await this.prisma.class_fee_schedule.create({
      data: {
        class_id: dto.class_id,
        fee_id: dto.fee_id,
        amount: dto.amount,
        ...(dto.campus_id !== undefined && { campus_id: dto.campus_id }),
        ...(dto.academic_year && { academic_year: dto.academic_year }),
      },
      include: {
        classes: true,
        fee_types: true,
        campuses: true,
      },
    });
    this.auditLogs.log({
      entity_type: 'CLASS_FEE_SCHEDULE',
      entity_id: String(record.id),
      action: 'CREATED',
      section: 'finance',
      new_value: `class=${dto.class_id}, fee=${dto.fee_id}, amount=${dto.amount}`,
      changed_by: changedBy ?? 'system',
    });
    return record;
  }

  async bulkUpdate(dto: BulkUpdateClassFeeScheduleDto, changedBy?: string) {
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
            ...(item.academic_year && { academic_year: item.academic_year }),
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

    this.auditLogs.log({
      entity_type: 'CLASS_FEE_SCHEDULE',
      entity_id: dto.items.map(i => i.id).join(','),
      action: 'UPDATED',
      section: 'finance',
      note: `Bulk updated ${dto.items.length} class fee schedule entries`,
      changed_by: changedBy ?? 'system',
    });
    return updated;
  }

  async remove(id: number, changedBy?: string) {
    const record = await this.prisma.class_fee_schedule.delete({
      where: { id },
    });
    this.auditLogs.log({
      entity_type: 'CLASS_FEE_SCHEDULE',
      entity_id: String(id),
      action: 'DELETED',
      section: 'finance',
      changed_by: changedBy ?? 'system',
    });
    return record;
  }

  async copyHistory(fromYear: string, toYear: string) {
    const sourceRecords = await this.prisma.class_fee_schedule.findMany({
      where: { academic_year: fromYear },
    });

    if (sourceRecords.length === 0) {
      return { count: 0 };
    }

    // Use createMany if database supports it, or a transaction of creates
    // Note: createMany might not handle unique constraints gracefully depending on DB
    // We'll use a transaction with upsert-like logic or clear target first.
    return this.prisma.$transaction(async (tx) => {
      // Clear target year records first to avoid duplicates
      await tx.class_fee_schedule.deleteMany({
        where: { academic_year: toYear },
      });

      const newRecords = sourceRecords.map((r) => ({
        class_id: r.class_id,
        fee_id: r.fee_id,
        amount: r.amount,
        campus_id: r.campus_id,
        academic_year: toYear,
      }));

      const result = await tx.class_fee_schedule.createMany({
        data: newRecords,
      });

      return result;
    });
  }
}
