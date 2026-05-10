import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateDiscountPresetDto, UpdateDiscountPresetDto } from './dto/discount-presets.dto';

@Injectable()
export class DiscountPresetsService {
    constructor(private readonly prisma: PrismaService) {}

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

    async create(dto: CreateDiscountPresetDto) {
        return this.prisma.discount_presets.create({
            data: {
                title: dto.title,
                description: dto.description ?? null,
                is_active: dto.is_active ?? true,
            },
        });
    }

    async update(id: number, dto: UpdateDiscountPresetDto) {
        await this.findOne(id);
        return this.prisma.discount_presets.update({
            where: { id },
            data: {
                ...(dto.title !== undefined && { title: dto.title }),
                ...(dto.description !== undefined && { description: dto.description }),
                ...(dto.is_active !== undefined && { is_active: dto.is_active }),
            },
        });
    }

    async remove(id: number) {
        await this.findOne(id);
        // Soft-delete by deactivating rather than hard-deleting (preserves referential integrity)
        return this.prisma.discount_presets.update({
            where: { id },
            data: { is_active: false },
        });
    }
}
