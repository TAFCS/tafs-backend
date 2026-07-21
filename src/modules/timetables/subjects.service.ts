import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  CreateSubjectDto,
  ListSubjectsQueryDto,
  UpdateSubjectDto,
} from './dto/timetables.dto';

@Injectable()
export class SubjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async list(query: ListSubjectsQueryDto) {
    const where: Prisma.subjectsWhereInput = {};
    if (query.academic_system) {
      where.academic_system = query.academic_system;
    }
    if (query.active !== undefined) {
      where.is_active = query.active;
    }
    return this.prisma.subjects.findMany({
      where,
      orderBy: [{ name: 'asc' }],
    });
  }

  async create(dto: CreateSubjectDto, changedBy?: string) {
    const name = dto.name.trim().toUpperCase();
    try {
      const record = await this.prisma.subjects.create({
        data: {
          name,
          code: dto.code?.trim() || null,
          academic_system: dto.academic_system?.trim() || 'A-Level',
          is_active: true,
        },
      });

      await this.auditLogs.log({
        entity_type: 'SUBJECT',
        entity_id: String(record.id),
        action: 'CREATED',
        new_value: record.name,
        changed_by: changedBy ?? 'system',
        note: `Created subject #${record.id} ("${record.name}"` +
          (record.code ? `, code ${record.code}` : '') +
          `, system ${record.academic_system ?? '—'}).`,
      });

      return record;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'A subject with this name already exists for this academic system',
        );
      }
      throw e;
    }
  }

  async update(id: number, dto: UpdateSubjectDto, changedBy?: string) {
    const existing = await this.prisma.subjects.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Subject not found');

    try {
      const record = await this.prisma.subjects.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim().toUpperCase() } : {}),
          ...(dto.code !== undefined ? { code: dto.code?.trim() || null } : {}),
          ...(dto.academic_system !== undefined
            ? { academic_system: dto.academic_system?.trim() || null }
            : {}),
          ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
        },
      });

      const changes: string[] = [];
      if (existing.name !== record.name) {
        changes.push(`name "${existing.name}" → "${record.name}"`);
      }
      if ((existing.code ?? null) !== (record.code ?? null)) {
        changes.push(`code "${existing.code ?? '—'}" → "${record.code ?? '—'}"`);
      }
      if ((existing.academic_system ?? null) !== (record.academic_system ?? null)) {
        changes.push(`system "${existing.academic_system ?? '—'}" → "${record.academic_system ?? '—'}"`);
      }
      if (existing.is_active !== record.is_active) {
        changes.push(`is_active ${existing.is_active} → ${record.is_active}`);
      }

      await this.auditLogs.log({
        entity_type: 'SUBJECT',
        entity_id: String(id),
        action: 'UPDATED',
        changed_by: changedBy ?? 'system',
        note: changes.length > 0
          ? `Subject #${id} ("${existing.name}") updated: ${changes.join(', ')}.`
          : `Subject #${id} ("${existing.name}") update submitted with no effective changes.`,
      });

      return record;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'A subject with this name already exists for this academic system',
        );
      }
      throw e;
    }
  }

  async remove(id: number, changedBy?: string) {
    const existing = await this.prisma.subjects.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Subject not found');

    const slotCount = await this.prisma.timetable_slots.count({
      where: { subject_id: id },
    });

    if (slotCount > 0) {
      const record = await this.prisma.subjects.update({
        where: { id },
        data: { is_active: false },
      });
      await this.auditLogs.log({
        entity_type: 'SUBJECT',
        entity_id: String(id),
        action: 'DELETED',
        field: 'is_active',
        old_value: String(existing.is_active),
        new_value: 'false',
        changed_by: changedBy ?? 'system',
        note: `Subject #${id} ("${existing.name}") soft-deactivated (still used by ${slotCount} timetable slot(s)).`,
      });
      return record;
    }

    await this.prisma.subjects.delete({ where: { id } });
    await this.auditLogs.log({
      entity_type: 'SUBJECT',
      entity_id: String(id),
      action: 'DELETED',
      old_value: existing.name,
      changed_by: changedBy ?? 'system',
      note: `Subject #${id} ("${existing.name}") permanently deleted.`,
    });
    return { id, deleted: true };
  }
}
