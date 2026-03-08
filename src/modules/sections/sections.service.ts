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

  async delete(id: number) {
    try {
      return await this.prisma.$transaction(async (tx) => {
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

