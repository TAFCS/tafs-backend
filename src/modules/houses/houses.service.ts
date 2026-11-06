import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateHouseDto } from './dto/create-house.dto';
import { UpdateHouseDto } from './dto/update-house.dto';
import { BulkUpdateHousesDto } from './dto/bulk-update-houses.dto';

@Injectable()
export class HousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll(options?: { includeInactive?: boolean }) {
    const where: Prisma.housesWhereInput = {};
    if (!options?.includeInactive) {
      where.is_active = true;
    }

    return this.prisma.houses.findMany({
      where,
      orderBy: { id: 'asc' },
    });
  }

  async findOne(id: number) {
    const house = await this.prisma.houses.findUnique({
      where: { id },
    });
    if (!house) {
      throw new NotFoundException(`House #${id} not found`);
    }
    return house;
  }

  async create(dto: CreateHouseDto, changedBy?: string) {
    const record = await this.prisma.houses.create({
      data: {
        house_name: dto.house_name.trim(),
        house_color: dto.house_color?.trim() || null,
        is_active: dto.is_active ?? true,
      },
    });

    this.auditLogs.log({
      entity_type: 'HOUSE',
      entity_id: String(record.id),
      action: 'CREATED',
      section: 'school-setup',
      new_value: `${record.house_name} (${record.house_color ?? 'no color'})`,
      changed_by: changedBy ?? 'system',
    });

    return record;
  }

  async update(id: number, dto: UpdateHouseDto, changedBy?: string) {
    const before = await this.findOne(id);

    const updated = await this.prisma.houses.update({
      where: { id },
      data: {
        ...(dto.house_name !== undefined && { house_name: dto.house_name.trim() }),
        ...(dto.house_color !== undefined && { house_color: dto.house_color ? dto.house_color.trim() : null }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      },
    });

    const actor = changedBy ?? 'system';
    const notes: string[] = [];

    if (dto.house_name !== undefined && dto.house_name !== before.house_name) {
      notes.push(`name changed from "${before.house_name}" to "${updated.house_name}"`);
    }
    if (dto.house_color !== undefined && dto.house_color !== before.house_color) {
      notes.push(`color changed from "${before.house_color}" to "${updated.house_color}"`);
    }
    if (dto.is_active !== undefined && dto.is_active !== before.is_active) {
      notes.push(`status changed from ${before.is_active ? 'Active' : 'Inactive'} to ${updated.is_active ? 'Active' : 'Inactive'}`);
    }

    if (notes.length > 0) {
      this.auditLogs.log({
        entity_type: 'HOUSE',
        entity_id: String(id),
        action: 'UPDATED',
        section: 'school-setup',
        changed_by: actor,
        note: `House #${id} updated: ${notes.join(', ')}.`,
      });
    }

    return updated;
  }

  async bulkUpdate(dto: BulkUpdateHousesDto, changedBy?: string) {
    if (!dto.items || dto.items.length === 0) {
      return [];
    }

    const beforeRows = await this.prisma.houses.findMany({
      where: { id: { in: dto.items.map((i) => i.id) } },
    });
    const beforeMap = new Map(beforeRows.map((r) => [r.id, r]));

    const updated = await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.houses.update({
          where: { id: item.id },
          data: {
            ...(item.house_name !== undefined && { house_name: item.house_name.trim() }),
            ...(item.house_color !== undefined && { house_color: item.house_color ? item.house_color.trim() : null }),
            ...(item.is_active !== undefined && { is_active: item.is_active }),
          },
        }),
      ),
    );

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

      if (before.house_name !== record.house_name) {
        children.push({
          entity_type: 'HOUSE',
          entity_id: String(record.id),
          action: 'UPDATED',
          section: 'school-setup',
          field: 'house_name',
          old_value: before.house_name,
          new_value: record.house_name,
          note: `House #${record.id} name changed from "${before.house_name}" to "${record.house_name}".`,
        });
      }

      if (before.house_color !== record.house_color) {
        children.push({
          entity_type: 'HOUSE',
          entity_id: String(record.id),
          action: 'UPDATED',
          section: 'school-setup',
          field: 'house_color',
          old_value: before.house_color,
          new_value: record.house_color,
          note: `House #${record.id} color changed from "${before.house_color}" to "${record.house_color}".`,
        });
      }

      if (before.is_active !== record.is_active) {
        children.push({
          entity_type: 'HOUSE',
          entity_id: String(record.id),
          action: 'UPDATED',
          section: 'school-setup',
          field: 'is_active',
          old_value: String(before.is_active),
          new_value: String(record.is_active),
          note: `House #${record.id} status changed from ${before.is_active ? 'Active' : 'Inactive'} to ${record.is_active ? 'Active' : 'Inactive'}.`,
        });
      }
    }

    if (children.length > 0) {
      await this.auditLogs.logGroup(
        {
          entity_type: 'HOUSE',
          entity_id: 'BULK',
          action: 'UPDATED',
          section: 'school-setup',
          changed_by: actor,
          note: `Bulk house save: ${children.length} house change(s) recorded.`,
        },
        children,
      );
    }

    return updated;
  }

  async getDependencies(id: number) {
    const students = await this.prisma.students.count({
      where: { house_id: id, deleted_at: null },
    });
    return { students };
  }

  async delete(id: number, changedBy?: string) {
    const house = await this.findOne(id);
    const deps = await this.getDependencies(id);

    if (deps.students > 0) {
      throw new BadRequestException(
        `Cannot delete ${house.house_name || 'House'} because ${deps.students} student(s) are assigned to it. Please deactivate it instead.`,
      );
    }

    const deleted = await this.prisma.houses.delete({
      where: { id },
    });

    this.auditLogs.log({
      entity_type: 'HOUSE',
      entity_id: String(id),
      action: 'DELETED',
      section: 'school-setup',
      old_value: `${house.house_name} (${house.house_color ?? 'no color'})`,
      changed_by: changedBy ?? 'system',
    });

    return deleted;
  }
}
