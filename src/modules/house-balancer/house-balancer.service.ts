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
import {
  ApplyCampusHouseBalanceDto,
  CampusHouseBalancePreviewDto,
} from './dto/campus-house-balance.dto';
import { HouseBalancerScopeDto } from './dto/house-balancer-scope.dto';
import { ProgressionHistoryService } from '../students/progression-history.service';

type TxClient = Prisma.TransactionClient;

type ScopedStudent = {
  cc: number;
  full_name: string;
  campus_id: number | null;
  class_id: number | null;
  section_id: number | null;
  house_id: number | null;
  academic_year: string | null;
  gr_number: string | null;
  houses: { id: number; house_name: string | null; house_color: string | null } | null;
};

type HouseRow = {
  id: number;
  house_name: string | null;
  house_color: string | null;
};

export type HouseMove = {
  student_id: number;
  student_cc: number;
  student_name: string;
  old_house: HouseRow | null;
  new_house: HouseRow;
};

type StoredMovesPayload = {
  moves_count: number;
  moves: HouseMove[];
  student_count?: number;
  group_count?: number;
  scope?: {
    campus_name?: string | null;
    class_name?: string | null;
    section_name?: string | null;
  };
  houses?: HouseRow[];
  before_counts?: Record<string, number>;
  after_counts?: Record<string, number>;
};

const HISTORY_ACTIONS = ['REBALANCED', 'CAMPUS_REBALANCED'] as const;

@Injectable()
export class HouseBalancerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly progressionHistory: ProgressionHistoryService,
  ) {}

  private houseLookup(houses: HouseRow[]): Map<number, HouseRow> {
    return new Map(houses.map((house) => [house.id, house]));
  }

  private toHouseRow(
    house: { id: number; house_name: string | null; house_color: string | null } | null | undefined,
  ): HouseRow | null {
    if (!house) return null;
    return {
      id: house.id,
      house_name: house.house_name,
      house_color: house.house_color,
    };
  }

  private buildMoves(
    students: ScopedStudent[],
    assignments: Array<{ student_id: number; house_id: number }>,
    houses: HouseRow[],
  ): HouseMove[] {
    const byId = new Map(students.map((student) => [student.cc, student]));
    const housesById = this.houseLookup(houses);
    const moves: HouseMove[] = [];

    for (const assignment of assignments) {
      const student = byId.get(assignment.student_id);
      if (!student) continue;
      if (student.house_id === assignment.house_id) continue;
      const newHouse = housesById.get(assignment.house_id);
      if (!newHouse) continue;
      moves.push({
        student_id: student.cc,
        student_cc: student.cc,
        student_name: student.full_name,
        old_house: this.toHouseRow(student.houses),
        new_house: newHouse,
      });
    }

    return moves;
  }

  private serializeMovesPayload(
    moves: HouseMove[],
    extras?: Omit<StoredMovesPayload, 'moves_count' | 'moves'>,
  ): string {
    const payload: StoredMovesPayload = {
      moves_count: moves.length,
      moves,
      ...extras,
    };
    return JSON.stringify(payload);
  }

  private countsForStorage(counts: Record<number, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, count] of Object.entries(counts)) {
      out[String(id)] = count;
    }
    return out;
  }

  private buildSectionNote(params: {
    studentCount: number;
    campusName: string;
    className: string;
    sectionName: string;
    houses: HouseRow[];
    beforeCounts: Record<number, number>;
    afterCounts: Record<number, number>;
  }): string {
    const houseSummary = params.houses
      .map((house) => {
        const before = params.beforeCounts[house.id] ?? 0;
        const after = params.afterCounts[house.id] ?? 0;
        const label = house.house_name || `House #${house.id}`;
        return `${label} ${before}→${after}`;
      })
      .join(', ');
    return `Rebalanced ${params.studentCount} students · ${params.campusName} · ${params.className} · Section ${params.sectionName}. Houses: ${houseSummary}`;
  }

  private buildCampusNote(params: {
    studentCount: number;
    groupCount: number;
    campusName: string;
    className?: string | null;
  }): string {
    const classPart = params.className ? ` · ${params.className}` : ' (all classes)';
    return `Rebalanced ${params.studentCount} students across ${params.groupCount} class/section groups · ${params.campusName}${classPart}`;
  }

  private parseMovesPayload(newValue: string | null | undefined): StoredMovesPayload {
    if (!newValue) {
      return { moves_count: 0, moves: [] };
    }
    try {
      const parsed = JSON.parse(newValue) as Partial<StoredMovesPayload>;
      const moves = Array.isArray(parsed.moves) ? (parsed.moves as HouseMove[]) : [];
      return {
        moves_count:
          typeof parsed.moves_count === 'number' ? parsed.moves_count : moves.length,
        moves,
      };
    } catch {
      return { moves_count: 0, moves: [] };
    }
  }

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

  private buildCampusFingerprint(
    students: Array<{
      cc: number;
      class_id: number | null;
      section_id: number | null;
      house_id: number | null;
    }>,
  ): string {
    const payload = students
      .map(
        (student) =>
          `${student.cc}:${student.class_id ?? ''}:${student.section_id ?? ''}:${student.house_id ?? ''}`,
      )
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
        campus_id: true,
        class_id: true,
        section_id: true,
        house_id: true,
        academic_year: true,
        gr_number: true,
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

      const moves = this.buildMoves(students, dto.assignments, houses);
      const studentByCc = new Map(students.map((s) => [s.cc, s]));

      for (const item of dto.assignments) {
        await tx.students.update({
          where: { cc: item.student_id },
          data: { house_id: item.house_id },
        });
        const prior = studentByCc.get(item.student_id);
        if (!prior || prior.house_id === item.house_id) continue;
        await this.progressionHistory.recordProgressionChange(tx, {
          studentCc: item.student_id,
          campusId: prior.campus_id,
          classId: prior.class_id,
          sectionId: prior.section_id,
          houseId: item.house_id,
          academicYear: prior.academic_year,
          grNumber: prior.gr_number,
          changeType: 'HOUSE_CHANGED',
          changedBy: changedBy ?? 'system',
          notes: 'Reassigned via house balancer',
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
        moves,
        moves_count: moves.length,
      };
    });

    await this.auditLogs.log({
      entity_type: 'HOUSE',
      entity_id: `${dto.campus_id}:${dto.class_id}:${dto.section_id}`,
      action: 'REBALANCED',
      section: 'house-balancer',
      changed_by: changedBy ?? 'system',
      note: this.buildSectionNote({
        studentCount: result.student_count,
        campusName: result.campus.campus_name,
        className: result.class.description,
        sectionName: result.section.description,
        houses: result.houses,
        beforeCounts: result.before_counts,
        afterCounts: result.after_counts,
      }),
      new_value: this.serializeMovesPayload(result.moves, {
        student_count: result.student_count,
        scope: {
          campus_name: result.campus.campus_name,
          class_name: result.class.description,
          section_name: result.section.description,
        },
        houses: result.houses,
        before_counts: this.countsForStorage(result.before_counts),
        after_counts: this.countsForStorage(result.after_counts),
      }),
    });

    await Promise.all(
      result.moves.map((move) =>
        this.auditLogs.log({
          entity_type: 'STUDENT',
          entity_id: String(move.student_id),
          action: 'REBALANCED',
          field: 'student.house_id',
          old_value: move.old_house ? String(move.old_house.id) : null,
          new_value: String(move.new_house.id),
          changed_by: changedBy ?? 'system',
          student_id: move.student_id,
          note: 'Reassigned via house balancer',
        }),
      ),
    );

    return result;
  }

  async previewCampus(dto: CampusHouseBalancePreviewDto) {
    const campus = await this.prisma.campuses.findUnique({
      where: { id: dto.campus_id },
      select: { id: true, campus_name: true, campus_code: true },
    });
    if (!campus) {
      throw new NotFoundException(`Campus #${dto.campus_id} not found`);
    }

    if (dto.class_id) {
      const cls = await this.prisma.classes.findUnique({
        where: { id: dto.class_id },
        select: { id: true },
      });
      if (!cls) {
        throw new NotFoundException(`Class #${dto.class_id} not found`);
      }
    }

    const [houses, offerings, campusStudents] = await Promise.all([
      this.prisma.houses.findMany({ orderBy: { id: 'asc' } }),
      this.prisma.campus_sections.findMany({
        where: {
          campus_id: dto.campus_id,
          is_active: true,
          ...(dto.class_id ? { class_id: dto.class_id } : {}),
        },
        select: {
          class_id: true,
          section_id: true,
          classes: {
            select: { id: true, description: true, class_code: true },
          },
          sections: {
            select: { id: true, description: true },
          },
        },
        orderBy: [{ class_id: 'asc' }, { section_id: 'asc' }],
      }),
      this.prisma.students.findMany({
        where: {
          campus_id: dto.campus_id,
          ...(dto.class_id ? { class_id: dto.class_id } : { class_id: { not: null } }),
          section_id: { not: null },
          status: student_status.ENROLLED,
          deleted_at: null,
        },
        select: {
          cc: true,
          full_name: true,
          campus_id: true,
          class_id: true,
          section_id: true,
          house_id: true,
          academic_year: true,
          gr_number: true,
          houses: {
            select: { id: true, house_name: true, house_color: true },
          },
        },
        orderBy: { cc: 'asc' },
      }),
    ]);

    if (houses.length === 0) {
      throw new BadRequestException({
        code: 'NO_HOUSES',
        message: 'No houses are configured',
      });
    }

    const houseIds = houses.map((house) => house.id);
    const groups = offerings.flatMap((offering) => {
      const students = campusStudents.filter(
        (student) =>
          student.class_id === offering.class_id &&
          student.section_id === offering.section_id,
      );
      if (students.length === 0) return [];

      const assignments = this.buildBalancedAssignments(students, houses);
      return [
        {
          class: offering.classes,
          section: offering.sections,
          student_count: students.length,
          roster_fingerprint: this.buildFingerprint(students),
          current_counts: this.countByHouse(
            houseIds,
            students.map((student) => ({ house_id: student.house_id })),
          ),
          proposed_counts: this.countByHouse(
            houseIds,
            assignments.map((assignment) => ({
              house_id: assignment.proposed_house.id,
            })),
          ),
          assignments,
        },
      ];
    });

    if (groups.length === 0) {
      throw new BadRequestException({
        code: dto.class_id ? 'EMPTY_CLASS_ROSTER' : 'EMPTY_CAMPUS_ROSTER',
        message: dto.class_id
          ? 'No enrolled students with configured section were found in this class'
          : 'No enrolled students with configured class and section were found at this campus',
      });
    }

    return {
      campus,
      total_students: groups.reduce(
        (total, group) => total + group.student_count,
        0,
      ),
      group_count: groups.length,
      campus_fingerprint: this.buildCampusFingerprint(campusStudents),
      houses,
      groups,
    };
  }

  async applyCampus(dto: ApplyCampusHouseBalanceDto, changedBy?: string) {
    const campus = await this.prisma.campuses.findUnique({
      where: { id: dto.campus_id },
      select: { id: true, campus_name: true, campus_code: true },
    });
    if (!campus) {
      throw new NotFoundException(`Campus #${dto.campus_id} not found`);
    }

    const houses = await this.prisma.houses.findMany({
      orderBy: { id: 'asc' },
    });
    if (houses.length === 0) {
      throw new BadRequestException({
        code: 'NO_HOUSES',
        message: 'No houses are configured',
      });
    }

    const houseIds = new Set(houses.map((house) => house.id));
    const sortedGroups = [...dto.groups].sort(
      (left, right) =>
        left.class_id - right.class_id ||
        left.section_id - right.section_id,
    );
    const scopeKeys = new Set<string>();
    for (const group of sortedGroups) {
      const key = `${group.class_id}:${group.section_id}`;
      if (scopeKeys.has(key)) {
        throw new BadRequestException({
          code: 'HOUSE_GROUP_DUPLICATE',
          message: `Duplicate class/section group ${key}`,
        });
      }
      scopeKeys.add(key);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock every active section at the campus/class before checking the fingerprint.
      // This also covers sections that were empty during preview.
      const activeOfferings = await tx.campus_sections.findMany({
        where: {
          campus_id: dto.campus_id,
          is_active: true,
          ...(dto.class_id ? { class_id: dto.class_id } : {}),
        },
        select: { class_id: true, section_id: true },
        orderBy: [{ class_id: 'asc' }, { section_id: 'asc' }],
      });
      for (const offering of activeOfferings) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${this.lockKey(
          dto.campus_id,
          offering.class_id,
          offering.section_id,
        )})`;
      }

      const campusStudents = await tx.students.findMany({
        where: {
          campus_id: dto.campus_id,
          ...(dto.class_id ? { class_id: dto.class_id } : { class_id: { not: null } }),
          section_id: { not: null },
          status: student_status.ENROLLED,
          deleted_at: null,
        },
        select: {
          cc: true,
          class_id: true,
          section_id: true,
          house_id: true,
        },
        orderBy: { cc: 'asc' },
      });

      if (
        this.buildCampusFingerprint(campusStudents) !== dto.campus_fingerprint
      ) {
        throw new ConflictException({
          code: 'HOUSE_PREVIEW_STALE',
          message:
            'The campus roster changed since this preview was generated. Please refresh the preview.',
        });
      }

      let totalStudents = 0;
      const summaries: Array<{
        class_id: number;
        section_id: number;
        student_count: number;
        before_counts: Record<number, number>;
        after_counts: Record<number, number>;
      }> = [];
      const moves: HouseMove[] = [];

      for (const group of sortedGroups) {
        const offering = await tx.campus_sections.findUnique({
          where: {
            campus_id_class_id_section_id: {
              campus_id: dto.campus_id,
              class_id: group.class_id,
              section_id: group.section_id,
            },
          },
          select: { id: true, is_active: true },
        });
        if (!offering || offering.is_active === false) {
          throw new BadRequestException({
            code: 'SECTION_NOT_OFFERED',
            message: `Class #${group.class_id} / section #${group.section_id} is not active at this campus`,
          });
        }

        const scope = {
          campus_id: dto.campus_id,
          class_id: group.class_id,
          section_id: group.section_id,
        };
        const students = await this.loadScopedStudents(scope, tx);
        if (this.buildFingerprint(students) !== group.roster_fingerprint) {
          throw new ConflictException({
            code: 'HOUSE_PREVIEW_STALE',
            message:
              'A class/section roster changed since this preview was generated. Please refresh the preview.',
          });
        }
        if (students.length !== group.assignments.length) {
          throw new BadRequestException({
            code: 'HOUSE_ASSIGNMENT_INCOMPLETE',
            message: `Assignments for class #${group.class_id} / section #${group.section_id} must include every student exactly once`,
          });
        }

        const scopedIds = new Set(students.map((student) => student.cc));
        const seenIds = new Set<number>();
        for (const assignment of group.assignments) {
          if (
            !scopedIds.has(assignment.student_id) ||
            seenIds.has(assignment.student_id)
          ) {
            throw new BadRequestException({
              code: 'HOUSE_ASSIGNMENT_INVALID',
              message: `Invalid or duplicate student #${assignment.student_id} in campus-wide assignments`,
            });
          }
          if (!houseIds.has(assignment.house_id)) {
            throw new BadRequestException({
              code: 'HOUSE_NOT_FOUND',
              message: `House #${assignment.house_id} does not exist`,
            });
          }
          seenIds.add(assignment.student_id);
        }

        this.assertBalanced(
          houses.map((house) => house.id),
          group.assignments.map((assignment) => assignment.house_id),
        );

        const beforeCounts = this.countByHouse(
          houses.map((house) => house.id),
          students.map((student) => ({ house_id: student.house_id })),
        );
        const studentByCc = new Map(students.map((student) => [student.cc, student]));
        moves.push(...this.buildMoves(students, group.assignments, houses));
        for (const assignment of group.assignments) {
          await tx.students.update({
            where: { cc: assignment.student_id },
            data: { house_id: assignment.house_id },
          });
          const prior = studentByCc.get(assignment.student_id);
          if (!prior || prior.house_id === assignment.house_id) continue;
          await this.progressionHistory.recordProgressionChange(tx, {
            studentCc: assignment.student_id,
            campusId: prior.campus_id,
            classId: prior.class_id,
            sectionId: prior.section_id,
            houseId: assignment.house_id,
            academicYear: prior.academic_year,
            grNumber: prior.gr_number,
            changeType: 'HOUSE_CHANGED',
            changedBy: changedBy ?? 'system',
            notes: 'Reassigned via campus-wide house balancer',
          });
        }
        const afterCounts = this.countByHouse(
          houses.map((house) => house.id),
          group.assignments.map((assignment) => ({
            house_id: assignment.house_id,
          })),
        );
        totalStudents += students.length;
        summaries.push({
          class_id: group.class_id,
          section_id: group.section_id,
          student_count: students.length,
          before_counts: beforeCounts,
          after_counts: afterCounts,
        });
      }

      return {
        campus,
        total_students: totalStudents,
        group_count: summaries.length,
        groups: summaries,
        moves,
        moves_count: moves.length,
      };
    });

    const classLabel = dto.class_id
      ? (
          await this.prisma.classes.findUnique({
            where: { id: dto.class_id },
            select: { description: true },
          })
        )?.description ?? `Class #${dto.class_id}`
      : null;

    await this.auditLogs.log({
      entity_type: 'HOUSE',
      entity_id: dto.class_id
        ? `campus:${dto.campus_id}:class:${dto.class_id}`
        : `campus:${dto.campus_id}`,
      action: 'CAMPUS_REBALANCED',
      section: 'house-balancer',
      changed_by: changedBy ?? 'system',
      note: this.buildCampusNote({
        studentCount: result.total_students,
        groupCount: result.group_count,
        campusName: result.campus.campus_name,
        className: classLabel,
      }),
      new_value: this.serializeMovesPayload(result.moves, {
        student_count: result.total_students,
        group_count: result.group_count,
        scope: {
          campus_name: result.campus.campus_name,
          class_name: classLabel,
          section_name: null,
        },
      }),
    });

    await Promise.all(
      result.moves.map((move) =>
        this.auditLogs.log({
          entity_type: 'STUDENT',
          entity_id: String(move.student_id),
          action: 'REBALANCED',
          field: 'student.house_id',
          old_value: move.old_house ? String(move.old_house.id) : null,
          new_value: String(move.new_house.id),
          changed_by: changedBy ?? 'system',
          student_id: move.student_id,
          note: 'Reassigned via campus-wide house balancer',
        }),
      ),
    );

    return result;
  }

  async listHistory(campusId: number, limit = 20, offset = 0) {
    const campus = await this.prisma.campuses.findUnique({
      where: { id: campusId },
      select: { id: true },
    });
    if (!campus) {
      throw new NotFoundException(`Campus #${campusId} not found`);
    }

    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safeOffset = Math.max(offset, 0);

    const where: Prisma.audit_logsWhereInput = {
      entity_type: 'HOUSE',
      action: { in: [...HISTORY_ACTIONS] },
      OR: [
        { entity_id: { startsWith: `${campusId}:` } },
        { entity_id: `campus:${campusId}` },
        { entity_id: { startsWith: `campus:${campusId}:` } },
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.audit_logs.findMany({
        where,
        orderBy: { changed_at: 'desc' },
        take: safeLimit,
        skip: safeOffset,
        select: {
          id: true,
          action: true,
          entity_id: true,
          changed_by: true,
          changed_at: true,
          note: true,
          new_value: true,
        },
      }),
      this.prisma.audit_logs.count({ where }),
    ]);

    return {
      total,
      limit: safeLimit,
      offset: safeOffset,
      items: rows.map((row) => {
        const payload = this.parseMovesPayload(row.new_value);
        return {
          id: row.id,
          action: row.action,
          entity_id: row.entity_id,
          changed_by: row.changed_by,
          changed_at: row.changed_at,
          note: row.note,
          moves_count: payload.moves_count,
        };
      }),
    };
  }

  async getHistory(id: number) {
    const row = await this.prisma.audit_logs.findUnique({
      where: { id },
      select: {
        id: true,
        action: true,
        entity_type: true,
        entity_id: true,
        changed_by: true,
        changed_at: true,
        note: true,
        new_value: true,
      },
    });

    if (
      !row ||
      row.entity_type !== 'HOUSE' ||
      !HISTORY_ACTIONS.includes(row.action as (typeof HISTORY_ACTIONS)[number])
    ) {
      throw new NotFoundException(`House rebalance history #${id} not found`);
    }

    const payload = this.parseMovesPayload(row.new_value);
    return {
      id: row.id,
      action: row.action,
      entity_id: row.entity_id,
      changed_by: row.changed_by,
      changed_at: row.changed_at,
      note: row.note,
      moves_count: payload.moves_count,
      moves: payload.moves,
    };
  }
}
