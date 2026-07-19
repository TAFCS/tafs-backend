import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { Prisma, student_status } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ApplyHouseBalanceDto } from './dto/apply-house-balance.dto';
import { HouseBalancerScopeDto } from './dto/house-balancer-scope.dto';

type TxClient = Prisma.TransactionClient;

type ScopedStudent = {
  cc: number;
  full_name: string;
  house_id: number | null;
  houses: { id: number; house_name: string | null; house_color: string | null } | null;
};

type HouseRow = {
  id: number;
  house_name: string | null;
  house_color: string | null;
};

@Injectable()
export class HouseBalancerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private lockKey(campusId: number, classId: number, sectionId: number): number {
    const raw =
      ((campusId * 73856093) ^ (classId * 19349663) ^ (sectionId * 83492791) ^ 0x484F5553) >>> 0;
    return raw % 2147483647;
  }

  private shuffleInPlace<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  private buildFingerprint(students: Array<{ cc: number; house_id: number | null }>): string {
    const payload = students
      .map((s) => `${s.cc}:${s.house_id ?? ''}`)
      .sort()
      .join('|');
    return createHash('sha256').update(payload).digest('hex');
  }

  private countByHouse(
    houseIds: number[],
    assignments: Array<{ house_id: number | null }>,
  ): Record<number, number> {
    const counts: Record<number, number> = {};
    for (const id of houseIds) counts[id] = 0;
    for (const a of assignments) {
      if (a.house_id == null) continue;
      counts[a.house_id] = (counts[a.house_id] ?? 0) + 1;
    }
    return counts;
  }

  private assertBalanced(houseIds: number[], assignedHouseIds: number[]): void {
    if (houseIds.length === 0) {
      throw new BadRequestException({
        code: 'NO_HOUSES',
        message: 'No houses are configured',
      });
    }
    const counts = houseIds.map(
      (id) => assignedHouseIds.filter((hid) => hid === id).length,
    );
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    if (max - min > 1) {
      throw new BadRequestException({
        code: 'HOUSE_ASSIGNMENT_UNBALANCED',
        message: 'Proposed house assignments are not evenly balanced',
      });
    }
  }

  private async loadScopeMeta(dto: HouseBalancerScopeDto) {
    const [campus, cls, section, offering] = await Promise.all([
      this.prisma.campuses.findUnique({
        where: { id: dto.campus_id },
        select: { id: true, campus_name: true, campus_code: true },
      }),
      this.prisma.classes.findUnique({
        where: { id: dto.class_id },
        select: { id: true, description: true, class_code: true },
      }),
      this.prisma.sections.findUnique({
        where: { id: dto.section_id },
        select: { id: true, description: true },
      }),
      this.prisma.campus_sections.findUnique({
        where: {
          campus_id_class_id_section_id: {
            campus_id: dto.campus_id,
            class_id: dto.class_id,
            section_id: dto.section_id,
          },
        },
        select: { id: true, is_active: true },
      }),
    ]);

    if (!campus) throw new NotFoundException(`Campus #${dto.campus_id} not found`);
    if (!cls) throw new NotFoundException(`Class #${dto.class_id} not found`);
    if (!section) throw new NotFoundException(`Section #${dto.section_id} not found`);
    if (!offering) {
      throw new BadRequestException({
        code: 'SECTION_NOT_OFFERED',
        message: 'Section is not offered for this campus/class',
      });
    }
    if (offering.is_active === false) {
      throw new BadRequestException({
        code: 'SECTION_INACTIVE',
        message: 'Section offering is inactive for this campus/class',
      });
    }

    return { campus, cls, section };
  }

  private async loadScopedStudents(
    dto: HouseBalancerScopeDto,
    tx: TxClient | PrismaService = this.prisma,
  ): Promise<ScopedStudent[]> {
    return tx.students.findMany({
      where: {
        campus_id: dto.campus_id,
        class_id: dto.class_id,
        section_id: dto.section_id,
        status: student_status.ENROLLED,
        deleted_at: null,
      },
      select: {
        cc: true,
        full_name: true,
        house_id: true,
        houses: {
          select: { id: true, house_name: true, house_color: true },
        },
      },
      orderBy: { cc: 'asc' },
    });
  }

  private buildBalancedAssignments(students: ScopedStudent[], houses: HouseRow[]) {
    if (houses.length === 0) {
      throw new BadRequestException({
        code: 'NO_HOUSES',
        message: 'No houses are configured',
      });
    }
    if (students.length === 0) {
      throw new BadRequestException({
        code: 'EMPTY_ROSTER',
        message: 'No enrolled students found in this campus/class/section',
      });
    }

    const shuffledStudents = this.shuffleInPlace([...students]);
    const shuffledHouses = this.shuffleInPlace([...houses]);

    const assignments = shuffledStudents.map((student, index) => {
      const house = shuffledHouses[index % shuffledHouses.length];
      return {
        student_id: student.cc,
        student_cc: student.cc,
        student_name: student.full_name,
        current_house: student.houses
          ? {
              id: student.houses.id,
              house_name: student.houses.house_name,
              house_color: student.houses.house_color,
            }
          : null,
        proposed_house: {
          id: house.id,
          house_name: house.house_name,
          house_color: house.house_color,
        },
      };
    });

    this.assertBalanced(
      houses.map((h) => h.id),
      assignments.map((a) => a.proposed_house.id),
    );

    return assignments;
  }

  async preview(dto: HouseBalancerScopeDto) {
    const meta = await this.loadScopeMeta(dto);
    const [students, houses] = await Promise.all([
      this.loadScopedStudents(dto),
      this.prisma.houses.findMany({ orderBy: { id: 'asc' } }),
    ]);

    const assignments = this.buildBalancedAssignments(students, houses);
    const houseIds = houses.map((h) => h.id);

    return {
      campus: meta.campus,
      class: meta.cls,
      section: meta.section,
      student_count: students.length,
      roster_fingerprint: this.buildFingerprint(students),
      current_counts: this.countByHouse(
        houseIds,
        students.map((s) => ({ house_id: s.house_id })),
      ),
      proposed_counts: this.countByHouse(
        houseIds,
        assignments.map((a) => ({ house_id: a.proposed_house.id })),
      ),
      houses,
      assignments,
    };
  }

  async apply(dto: ApplyHouseBalanceDto, changedBy?: string) {
    const meta = await this.loadScopeMeta(dto);
    const houses = await this.prisma.houses.findMany({ orderBy: { id: 'asc' } });
    const houseIds = new Set(houses.map((h) => h.id));

    if (houses.length === 0) {
      throw new BadRequestException({
        code: 'NO_HOUSES',
        message: 'No houses are configured',
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${this.lockKey(
        dto.campus_id,
        dto.class_id,
        dto.section_id,
      )})`;

      const students = await this.loadScopedStudents(dto, tx);
      if (students.length === 0) {
        throw new BadRequestException({
          code: 'EMPTY_ROSTER',
          message: 'No enrolled students found in this campus/class/section',
        });
      }

      const fingerprint = this.buildFingerprint(students);
      if (fingerprint !== dto.roster_fingerprint) {
        throw new ConflictException({
          code: 'HOUSE_PREVIEW_STALE',
          message:
            'Section roster changed since the preview was generated. Please generate a new preview.',
        });
      }

      if (dto.assignments.length !== students.length) {
        throw new BadRequestException({
          code: 'HOUSE_ASSIGNMENT_INCOMPLETE',
          message: 'Assignments must include every enrolled student in the section exactly once',
        });
      }

      const scopedIds = new Set(students.map((s) => s.cc));
      const seen = new Set<number>();
      for (const item of dto.assignments) {
        if (!scopedIds.has(item.student_id)) {
          throw new BadRequestException({
            code: 'HOUSE_ASSIGNMENT_OUT_OF_SCOPE',
            message: `Student #${item.student_id} is not in the selected section roster`,
          });
        }
        if (seen.has(item.student_id)) {
          throw new BadRequestException({
            code: 'HOUSE_ASSIGNMENT_DUPLICATE',
            message: `Duplicate assignment for student #${item.student_id}`,
          });
        }
        if (!houseIds.has(item.house_id)) {
          throw new BadRequestException({
            code: 'HOUSE_NOT_FOUND',
            message: `House #${item.house_id} does not exist`,
          });
        }
        seen.add(item.student_id);
      }

      this.assertBalanced(
        houses.map((h) => h.id),
        dto.assignments.map((a) => a.house_id),
      );

      const beforeCounts = this.countByHouse(
        houses.map((h) => h.id),
        students.map((s) => ({ house_id: s.house_id })),
      );

      for (const item of dto.assignments) {
        await tx.students.update({
          where: { cc: item.student_id },
          data: { house_id: item.house_id },
        });
      }

      const afterCounts = this.countByHouse(
        houses.map((h) => h.id),
        dto.assignments.map((a) => ({ house_id: a.house_id })),
      );

      return {
        campus: meta.campus,
        class: meta.cls,
        section: meta.section,
        student_count: students.length,
        before_counts: beforeCounts,
        after_counts: afterCounts,
        houses,
        assignments: dto.assignments,
      };
    });

    await this.auditLogs.log({
      entity_type: 'HOUSE',
      entity_id: `${dto.campus_id}:${dto.class_id}:${dto.section_id}`,
      action: 'REBALANCED',
      section: 'school-setup',
      changed_by: changedBy ?? 'system',
      note: `Rebalanced ${result.student_count} students for campus=${dto.campus_id} class=${dto.class_id} section=${dto.section_id}. before=${JSON.stringify(result.before_counts)} after=${JSON.stringify(result.after_counts)}`,
    });

    return result;
  }
}
