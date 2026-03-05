import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BulkUpdateSectionsDto } from './dto/bulk-update-sections.dto';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateSectionDto } from './dto/update-section.dto';

@Injectable()
export class SectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.sections.findMany({
      orderBy: { description: 'asc' },
    });
  }

  async create(dto: CreateSectionDto) {
    return this.prisma.sections.create({
      data: {
        description: dto.description,
      },
    });
  }

  async update(id: number, dto: UpdateSectionDto) {
    return this.prisma.sections.update({
      where: { id },
      data: {
        ...(dto.description !== undefined && {
          description: dto.description,
        }),
      },
    });
  }

  async bulkUpdate(dto: BulkUpdateSectionsDto) {
    if (!dto.items || dto.items.length === 0) {
      return [];
    }

    const updates = dto.items.filter((item) => item.id != null);
    const creates = dto.items.filter((item) => item.id == null);

    const results = await this.prisma.$transaction([
      ...updates.map((item) =>
        this.prisma.sections.update({
          where: { id: item.id! },
          data: {
            description: item.description,
          },
        }),
      ),
      ...creates.map((item) =>
        this.prisma.sections.create({
          data: {
            description: item.description,
          },
        }),
      ),
    ]);

    return results;
  }
}

