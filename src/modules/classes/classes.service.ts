import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BulkUpdateClassesDto } from './dto/bulk-update-classes.dto';
import { CreateClassDto } from './dto/create-class.dto';

@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.classes.findMany({
      orderBy: { description: 'asc' },
    });
  }

  async create(dto: CreateClassDto) {
    return this.prisma.classes.create({
      data: {
        description: dto.description,
        class_code: dto.class_code,
        academic_system: dto.academic_system,
      },
    });
  }

  async bulkUpdate(dto: BulkUpdateClassesDto) {
    if (!dto.items || dto.items.length === 0) {
      return [];
    }

    const updated = await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.classes.update({
          where: { id: item.id },
          data: {
            ...(item.description !== undefined && {
              description: item.description,
            }),
            ...(item.class_code !== undefined && {
              class_code: item.class_code,
            }),
            ...(item.academic_system !== undefined && {
              academic_system: item.academic_system,
            }),
          },
        }),
      ),
    );

    // Simple safeguard: if any item resulted in null (should not happen with update),
    // throw a not found to indicate bad IDs.
    if (!updated || updated.length !== dto.items.length) {
      throw new NotFoundException('One or more classes not found');
    }

    return updated;
  }

  async delete(id: number) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Unlink Students
        await tx.students.updateMany({
          where: { class_id: id },
          data: { class_id: null },
        });

        // 2. Delete assignments in junction tables
        await tx.campus_classes.deleteMany({
          where: { class_id: id },
        });

        await tx.campus_sections.deleteMany({
          where: { class_id: id },
        });

        // 3. Delete related fee schedules
        await tx.class_fee_schedule.deleteMany({
          where: { class_id: id },
        });

        // 4. Finally, delete the class record
        return await tx.classes.delete({
          where: { id },
        });
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Class #${id} not found`);
      }
      if (e?.code === 'P2003') {
        // Foreign key constraint failure (e.g. if we missed something and it's protected)
        throw new Error('Cannot delete class as it is being referenced by other records.');
      }
      throw e;
    }
  }
}
