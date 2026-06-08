import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

export class CreateStaffTypeDto {
  code: string;
  name: string;
  description?: string;
  is_active?: boolean;
}

export class UpdateStaffTypeDto {
  code?: string;
  name?: string;
  description?: string;
  is_active?: boolean;
}

@Injectable()
export class StaffTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.staff_types.findMany({ orderBy: { name: 'asc' } });
  }

  async findOne(id: number) {
    const staffType = await this.prisma.staff_types.findUnique({ where: { id } });
    if (!staffType) {
      throw new NotFoundException(`Staff type with ID ${id} not found`);
    }
    return staffType;
  }

  async create(dto: CreateStaffTypeDto) {
    return this.prisma.staff_types.create({
      data: {
        code: dto.code,
        name: dto.name,
        description: dto.description,
        is_active: dto.is_active ?? true,
      },
    });
  }

  async update(id: number, dto: UpdateStaffTypeDto) {
    await this.findOne(id);
    return this.prisma.staff_types.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.staff_types.delete({ where: { id } });
  }
}
