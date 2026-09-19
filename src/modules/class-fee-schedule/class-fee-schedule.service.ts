import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ScopeService } from '../../common/scope/scope.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateClassFeeScheduleDto } from './dto/create-class-fee-schedule.dto';
import { BulkUpdateClassFeeScheduleDto } from './dto/bulk-update-class-fee-schedule.dto';

@Injectable()
export class ClassFeeScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly scope: ScopeService,
  ) { }

  /**
   * A null campus_id is a genuine global default (applies to every campus),
   * not an unassigned row to hide — so it always stays visible, unlike the
   * usual "null falls outside a restricted dimension" rule elsewhere. Only
   * campus-specific rows are actually scoped.
   */
  private campusWhere(user: IJwtStaffPayload): Prisma.class_fee_scheduleWhereInput {
    if (this.scope.isExempt(user)) return {};
    const campuses = this.scope.scopeOf(user).campuses;
    if (campuses.length === 0) return {};
    return { OR: [{ campus_id: { in: campuses } }, { campus_id: null }] };
  }

  private canSeeSchedule(user: IJwtStaffPayload, row: { campus_id: number | null }): boolean {
    if (this.scope.isExempt(user)) return true;
    const campuses = this.scope.scopeOf(user).campuses;
    return campuses.length === 0 || row.campus_id == null || campuses.includes(row.campus_id);
  }

  /**
   * A scoped caller may only target their own campus(es) — and may never
   * create/move a row to campus_id null (a global default reaching every
   * campus), since that would let a campus-scoped user affect campuses
   * outside their own scope.
   */
  private assertTargetCampus(user: IJwtStaffPayload, campusId: number | null | undefined): void {
    if (this.scope.isExempt(user)) return;
    if (campusId == null) {
      throw new ForbiddenException('Only an unrestricted admin may set a schedule that applies to every campus.');
    }
    this.scope.assertCampus(user, campusId);
  }

  async findAll(academicYear: string | undefined, user: IJwtStaffPayload) {
    return this.prisma.class_fee_schedule.findMany({
      where: {
        ...(academicYear && { academic_year: academicYear }),
        ...this.campusWhere(user),
      },
      include: {
        classes: true,
        fee_types: true,
        campuses: true,
      },
    });
  }

  async findByClassId(classId: number, campusId?: number, academicYear?: string) {
    return this.prisma.class_fee_schedule.findMany({
      where: {
        class_id: classId,
        ...(academicYear ? { academic_year: academicYear } : {}),
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

  async create(dto: CreateClassFeeScheduleDto, changedBy: string | undefined, user: IJwtStaffPayload) {
    this.assertTargetCampus(user, dto.campus_id ?? null);
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

  async bulkUpdate(dto: BulkUpdateClassFeeScheduleDto, changedBy: string | undefined, user: IJwtStaffPayload) {
    if (!dto.items || dto.items.length === 0) {
      return [];
    }

    // Every existing row touched, and every target campus_id, must be in the
    // caller's own scope — or a scoped user could edit or reassign a
    // schedule they can't otherwise see or reach.
    const existing = await this.prisma.class_fee_schedule.findMany({
      where: { id: { in: dto.items.map((i) => i.id) } },
      select: { id: true, campus_id: true },
    });
    const existingById = new Map(existing.map((r) => [r.id, r]));
    for (const item of dto.items) {
      const row = existingById.get(item.id);
      if (!row || !this.canSeeSchedule(user, row)) {
        throw new NotFoundException(`Class fee schedule ${item.id} not found`);
      }
      if (item.campus_id !== undefined) {
        this.assertTargetCampus(user, item.campus_id);
      }
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

  async remove(id: number, changedBy: string | undefined, user: IJwtStaffPayload) {
    const existing = await this.prisma.class_fee_schedule.findUnique({
      where: { id },
      select: { id: true, campus_id: true },
    });
    if (!existing || !this.canSeeSchedule(user, existing)) {
      throw new NotFoundException(`Class fee schedule ${id} not found`);
    }
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

  // Deliberately unscoped: cloning a whole academic year's schedule forward
  // is an org-wide rollover operation, not a per-campus edit — gated by the
  // copy_history action (SUPER_ADMIN / legacy-bridge territory in practice),
  // not by campus scope.
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
