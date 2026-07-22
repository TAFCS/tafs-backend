import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { BulkUpdateClassesDto } from './dto/bulk-update-classes.dto';
import { CreateClassDto } from './dto/create-class.dto';

@Injectable()
export class ClassesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

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
      include: { segments: { select: { id: true, code: true, name: true, display_order: true } } },
    });

    return rows
      .map((cls) => ({
        ...cls,
        class_order: this.classOrder(cls.class_code, cls.description),
      }))
      .sort((a, b) => a.class_order - b.class_order);
  }

  async create(dto: CreateClassDto, changedBy?: string) {
    const record = await this.prisma.classes.create({
      data: {
        description: dto.description,
        class_code: dto.class_code,
        academic_system: dto.academic_system,
      },
    });
    this.auditLogs.log({ entity_type: 'CLASS', entity_id: String(record.id), action: 'CREATED', section: 'school-setup', new_value: `${dto.class_code} – ${dto.description}`, changed_by: changedBy ?? 'system' });
    return record;
  }

  async bulkUpdate(dto: BulkUpdateClassesDto, changedBy?: string) {
    if (!dto.items || dto.items.length === 0) {
      return [];
    }

    const beforeRows = await this.prisma.classes.findMany({
      where: { id: { in: dto.items.map((i) => i.id) } },
      select: { id: true, description: true, class_code: true, academic_system: true },
    });
    const beforeMap = new Map(beforeRows.map((r) => [r.id, r]));

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

    const actor = changedBy ?? 'system';
    for (const record of updated) {
      const before = beforeMap.get(record.id);
      if (!before) continue;
      const changes: string[] = [];
      if (before.class_code !== record.class_code) {
        changes.push(`code "${before.class_code}" → "${record.class_code}"`);
      }
      if (before.description !== record.description) {
        changes.push(`description "${before.description}" → "${record.description}"`);
      }
      if (before.academic_system !== record.academic_system) {
        changes.push(`academic_system "${before.academic_system ?? '—'}" → "${record.academic_system ?? '—'}"`);
      }
      if (changes.length > 0) {
        await this.auditLogs.log({
          entity_type: 'CLASS',
          entity_id: String(record.id),
          action: 'UPDATED',
          section: 'school-setup',
          changed_by: actor,
          note: `Class #${record.id} ("${before.class_code} – ${before.description}") bulk-updated: ${changes.join(', ')}.`,
        });
      }
    }

    return updated;
  }

  async getDependencies(id: number) {
    const [students, campusClasses, feeSchedules] = await Promise.all([
      this.prisma.students.count({ where: { class_id: id, deleted_at: null } }),
      this.prisma.campus_classes.count({ where: { class_id: id } }),
      this.prisma.class_fee_schedule.count({ where: { class_id: id } }),
    ]);
    return { students, campuses: campusClasses, feeSchedules };
  }

  async delete(id: number, changedBy?: string) {
    try {
      const cls = await this.prisma.classes.findUnique({ where: { id }, select: { description: true, class_code: true } });
      const record = await this.prisma.$transaction(async (tx) => {
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
      this.auditLogs.log({ entity_type: 'CLASS', entity_id: String(id), action: 'DELETED', section: 'school-setup', old_value: cls ? `${cls.class_code} – ${cls.description}` : undefined, changed_by: changedBy ?? 'system' });
      return record;
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
