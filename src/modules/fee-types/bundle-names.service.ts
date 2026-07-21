import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateBundleNameDto } from './dto/bundle-names.dto';

@Injectable()
export class BundleNamesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll(activeOnly = false) {
    return this.prisma.bundle_fee_type_names.findMany({
      where: activeOnly ? { is_active: true } : {},
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateBundleNameDto, changedBy?: string) {
    const record = await this.prisma.bundle_fee_type_names.create({
      data: {
        name: dto.name.trim().toUpperCase(),
        description: dto.description,
        is_active: dto.is_active ?? true,
      },
    });

    await this.auditLogs.log({
      entity_type: 'BUNDLE_NAME',
      entity_id: String(record.id),
      action: 'CREATED',
      new_value: record.name,
      changed_by: changedBy ?? 'system',
      note: `Created bundle name #${record.id} ("${record.name}")` +
        (record.description ? `: ${record.description}` : '') +
        `, is_active=${record.is_active}.`,
    });

    return record;
  }

  async update(id: number, dto: Partial<CreateBundleNameDto>, changedBy?: string) {
    const existing = await this.prisma.bundle_fee_type_names.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Bundle name with ID ${id} not found`);
    }

    const record = await this.prisma.bundle_fee_type_names.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.name && { name: dto.name.trim().toUpperCase() }),
      },
    });

    const changes: string[] = [];
    if (existing.name !== record.name) {
      changes.push(`name "${existing.name}" → "${record.name}"`);
    }
    if ((existing.description ?? null) !== (record.description ?? null)) {
      changes.push(`description "${existing.description ?? '—'}" → "${record.description ?? '—'}"`);
    }
    if (existing.is_active !== record.is_active) {
      changes.push(`is_active ${existing.is_active} → ${record.is_active}`);
    }

    await this.auditLogs.log({
      entity_type: 'BUNDLE_NAME',
      entity_id: String(id),
      action: 'UPDATED',
      changed_by: changedBy ?? 'system',
      note: changes.length > 0
        ? `Bundle name #${id} ("${existing.name}") updated: ${changes.join(', ')}.`
        : `Bundle name #${id} ("${existing.name}") update submitted with no effective changes.`,
    });

    return record;
  }

  async delete(id: number, changedBy?: string) {
    const existing = await this.prisma.bundle_fee_type_names.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Bundle name with ID ${id} not found`);
    }

    // Soft delete via is_active = false
    const record = await this.prisma.bundle_fee_type_names.update({
      where: { id },
      data: { is_active: false },
    });

    await this.auditLogs.log({
      entity_type: 'BUNDLE_NAME',
      entity_id: String(id),
      action: 'DELETED',
      field: 'is_active',
      old_value: String(existing.is_active),
      new_value: 'false',
      changed_by: changedBy ?? 'system',
      note: `Bundle name #${id} ("${existing.name}") soft-deleted (is_active → false).`,
    });

    return record;
  }
}
