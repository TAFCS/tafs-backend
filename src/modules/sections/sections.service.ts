import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateSectionDto } from './dto/create-section.dto';
import { BulkUpdateSectionsDto } from './dto/bulk-update-sections.dto';

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

  async bulkUpdate(dto: BulkUpdateSectionsDto) {
    if (!dto.items || dto.items.length === 0) {
      return [];
    }

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

    return updated;
  }
}

