import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BulkUpdateClassesDto } from './dto/bulk-update-classes.dto';
import { CreateClassDto } from './dto/create-class.dto';

@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Extract a numeric ordering rank from a class code or description.
   * Examples: "G1", "Grade 1", "1", "Class-10", "PlayGroup" → 1, 1, 1, 10, 0
   * PlayGroup / Nursery / KG are ranked as 0, -1, -2 for meaningful sort.
   */
  private classOrder(code: string, description: string): number {
    // Concatenate both code AND description so patterns are matched against the full label.
    // e.g. code="PN", description="Pre Nursery" → checks "pn pre nursery", hits 'nursery' → -2
    const label = (code + ' ' + description).toLowerCase().replace(/[^a-z0-9 ]/g, '');
    if (label.includes('playgroup')) return -3;
    if (label.includes('nursery') || label.includes('nur ')) return -2;
    if (label.includes('prep') || label.includes('kindergarten')) return -1;
    // Standalone "kg" — only match if it's a standalone token, not part of another word
    if (/\bkg\b/.test(label)) return -1;

    // Extract the first integer from the combined string (e.g. "Grade 10", "G10", "Class 10")
    const numeric = (code + ' ' + description).match(/\d+/);
    if (numeric) return parseInt(numeric[0], 10);

    return 999; // Unknown — sort last
  }

  async findAll() {
    const rows = await this.prisma.classes.findMany({
      orderBy: { id: 'asc' },
    });

    return rows
      .map((cls) => ({
        ...cls,
        class_order: this.classOrder(cls.class_code, cls.description),
      }))
      .sort((a, b) => a.class_order - b.class_order);
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
