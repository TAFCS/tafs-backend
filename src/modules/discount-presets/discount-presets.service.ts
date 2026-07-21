import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateDiscountPresetDto, UpdateDiscountPresetDto } from './dto/discount-presets.dto';

@Injectable()
export class DiscountPresetsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly auditLogs: AuditLogsService,
    ) {}

    async findAll(onlyActive = false) {
        return this.prisma.discount_presets.findMany({
            where: onlyActive ? { is_active: true } : undefined,
            orderBy: { title: 'asc' },
        });
    }

    async findOne(id: number) {
        const preset = await this.prisma.discount_presets.findUnique({ where: { id } });
        if (!preset) throw new NotFoundException(`Discount preset #${id} not found`);
        return preset;
    }

    async create(dto: CreateDiscountPresetDto, changedBy: string) {
        const created = await this.prisma.discount_presets.create({
            data: {
                title: dto.title,
                description: dto.description ?? null,
                is_active: dto.is_active ?? true,
            },
        });
        void this.auditLogs.log({
            entity_type: 'DISCOUNT_PRESET',
            entity_id: String(created.id),
            action: 'CREATED',
            changed_by: changedBy,
            note: `"${created.title}"${created.description ? ` — ${created.description}` : ''}`,
        });
        return created;
    }

    async update(id: number, dto: UpdateDiscountPresetDto, changedBy: string) {
        const existing = await this.findOne(id);
        const updated = await this.prisma.discount_presets.update({
            where: { id },
            data: {
                ...(dto.title !== undefined && { title: dto.title }),
                ...(dto.description !== undefined && { description: dto.description }),
                ...(dto.is_active !== undefined && { is_active: dto.is_active }),
            },
        });

        const changes: string[] = [];
        if (dto.title !== undefined && dto.title !== existing.title) {
            changes.push(`Title: ${existing.title} → ${dto.title}`);
        }
        if (dto.description !== undefined && dto.description !== existing.description) {
            changes.push(`Description: ${existing.description ?? '—'} → ${dto.description ?? '—'}`);
        }
        if (dto.is_active !== undefined && dto.is_active !== existing.is_active) {
            changes.push(`Active: ${existing.is_active} → ${dto.is_active}`);
        }
        void this.auditLogs.log({
            entity_type: 'DISCOUNT_PRESET',
            entity_id: String(id),
            action: 'UPDATED',
            changed_by: changedBy,
            note: changes.length > 0 ? changes.join('; ') : 'No field changes detected.',
        });
        return updated;
    }

    async remove(id: number, changedBy: string) {
        const existing = await this.findOne(id);
        // Soft-delete by deactivating rather than hard-deleting (preserves referential integrity)
        const deleted = await this.prisma.discount_presets.update({
            where: { id },
            data: { is_active: false },
        });
        void this.auditLogs.log({
            entity_type: 'DISCOUNT_PRESET',
            entity_id: String(id),
            action: 'DELETED',
            changed_by: changedBy,
            note: `Deactivated "${existing.title}".`,
        });
        return deleted;
    }
}
