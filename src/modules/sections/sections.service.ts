import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateSectionDto } from './dto/create-section.dto';
import { BulkUpdateSectionsDto } from './dto/bulk-update-sections.dto';

@Injectable()
export class SectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll() {
    return this.prisma.sections.findMany({
      orderBy: { description: 'asc' },
    });
  }

  async create(dto: CreateSectionDto, changedBy?: string) {
    const record = await this.prisma.sections.create({
      data: {
        description: dto.description,
      },
    });
    this.auditLogs.log({ entity_type: 'SECTION', entity_id: String(record.id), action: 'CREATED', section: 'school-setup', new_value: dto.description, changed_by: changedBy ?? 'system' });
    return record;
  }

  async bulkUpdate(dto: BulkUpdateSectionsDto, changedBy?: string) {
    if (!dto.items || dto.items.length === 0) {
      return [];
    }

    const beforeRows = await this.prisma.sections.findMany({
      where: { id: { in: dto.items.map((i) => i.id) } },
      select: { id: true, description: true },
    });
    const beforeMap = new Map(beforeRows.map((r) => [r.id, r]));

    const updated = await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.sections.update({
          where: { id: item.id },
          data: {
            ...(item.description !== undefined && {
              description: item.description,
            }),
          },
        }),
      ),
    );

    if (!updated || updated.length !== dto.items.length) {
      throw new NotFoundException('One or more sections not found');
    }

    const actor = changedBy ?? 'system';
    const children: Array<{
      entity_type: string;
      entity_id: string;
      action: string;
      section?: string;
      field?: string;
      old_value?: string | null;
      new_value?: string | null;
      note: string;
    }> = [];

    for (const record of updated) {
      const before = beforeMap.get(record.id);
      if (!before) continue;
      if (before.description !== record.description) {
        children.push({
          entity_type: 'SECTION',
          entity_id: String(record.id),
          action: 'UPDATED',
          section: 'school-setup',
          field: 'description',
          old_value: before.description,
          new_value: record.description,
          note: `Section #${record.id} description changed from "${before.description}" to "${record.description}".`,
        });
      }
    }

    if (children.length > 0) {
      await this.auditLogs.logGroup(
        {
          entity_type: 'SECTION',
          entity_id: 'BULK',
          action: 'UPDATED',
          section: 'school-setup',
          changed_by: actor,
          note: `Bulk section save: ${children.length} section(s) updated.`,
        },
        children,
      );
    }

    return updated;
  }

  async getDependencies(id: number) {
    const students = await this.prisma.students.count({ where: { section_id: id, deleted_at: null } });
    return { students };
  }

  async delete(id: number, changedBy?: string) {
    try {
      const sec = await this.prisma.sections.findUnique({ where: { id }, select: { description: true } });
      const record = await this.prisma.$transaction(async (tx) => {
        // 1. Unlink Students
        await tx.students.updateMany({
          where: { section_id: id },
          data: { section_id: null },
        });

        // 2. Delete assignments in junction tables
        await tx.campus_sections.deleteMany({
          where: { section_id: id },
        });

        // 3. Finally, delete the section record
        return await tx.sections.delete({
          where: { id },
        });
      });
      this.auditLogs.log({ entity_type: 'SECTION', entity_id: String(id), action: 'DELETED', section: 'school-setup', old_value: sec?.description ?? undefined, changed_by: changedBy ?? 'system' });
      return record;
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Section #${id} not found`);
      }
      if (e?.code === 'P2003') {
        throw new Error('Cannot delete section as it is being referenced by other records.');
      }
      throw e;
    }
  }
}

