import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateBundleNameDto } from './dto/bundle-names.dto';

@Injectable()
export class BundleNamesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(activeOnly = false) {
    return this.prisma.bundle_fee_type_names.findMany({
      where: activeOnly ? { is_active: true } : {},
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateBundleNameDto) {
    return this.prisma.bundle_fee_type_names.create({
      data: {
        name: dto.name.trim().toUpperCase(),
        description: dto.description,
        is_active: dto.is_active ?? true,
      },
    });
  }

  async update(id: number, dto: Partial<CreateBundleNameDto>) {
    const existing = await this.prisma.bundle_fee_type_names.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Bundle name with ID ${id} not found`);
    }

    return this.prisma.bundle_fee_type_names.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.name && { name: dto.name.trim().toUpperCase() }),
      },
    });
  }

  async delete(id: number) {
    const existing = await this.prisma.bundle_fee_type_names.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Bundle name with ID ${id} not found`);
    }

    // Soft delete via is_active = false
    return this.prisma.bundle_fee_type_names.update({
      where: { id },
      data: { is_active: false },
    });
  }
}
