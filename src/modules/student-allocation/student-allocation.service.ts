import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SectionGenderMode, student_status } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizeGender } from './gender-normalization';
import {
  ALLOCATION_ERROR_CODES,
  AllocationErrorCode,
  CampusSectionRules,
  PlacementStudentContext,
  PlacementTarget,
  SectionOccupancyStats,
} from './student-allocation.types';

type TxClient = Prisma.TransactionClient;

@Injectable()
export class StudentAllocationService {
  constructor(private readonly prisma: PrismaService) {}

  private allocationError(
    code: AllocationErrorCode,
    message: string,
    status: 'bad_request' | 'conflict' | 'not_found' = 'bad_request',
  ): never {
    const payload = { code, message };
    if (status === 'conflict') throw new ConflictException(payload);
    if (status === 'not_found') throw new NotFoundException(payload);
    throw new BadRequestException(payload);
  }

  private lockKey(campusId: number, classId: number, sectionId: number): number {
    // Stable 31-bit positive int for pg_advisory_xact_lock
    const raw = ((campusId * 73856093) ^ (classId * 19349663) ^ (sectionId * 83492791)) >>> 0;
    return raw % 2147483647;
  }

  async acquireSectionLock(tx: TxClient, target: PlacementTarget): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${this.lockKey(
      target.campusId,
      target.classId,
      target.sectionId,
    )})`;
  }

  async withSectionLock<T>(
    target: PlacementTarget,
    fn: (tx: TxClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.acquireSectionLock(tx, target);
      return fn(tx);
    });
  }

  async getCampusSectionRules(
    target: PlacementTarget,
    tx: TxClient | PrismaService = this.prisma,
  ): Promise<CampusSectionRules | null> {
    const row = await tx.campus_sections.findUnique({
      where: {
        campus_id_class_id_section_id: {
          campus_id: target.campusId,
          class_id: target.classId,
          section_id: target.sectionId,
        },
      },
      select: {
        id: true,
        campus_id: true,
        class_id: true,
        section_id: true,
        is_active: true,
        student_capacity: true,
        gender_mode: true,
      },
    });
    if (!row) return null;
    return {
      campus_section_id: row.id,
      campus_id: row.campus_id,
      class_id: row.class_id,
      section_id: row.section_id,
      is_active: row.is_active,
      student_capacity: row.student_capacity,
      gender_mode: row.gender_mode,
    };
  }

  async assertCampusClassActive(
    campusId: number,
    classId: number,
    tx: TxClient | PrismaService = this.prisma,
  ): Promise<void> {
    const mapping = await tx.campus_classes.findFirst({
      where: { campus_id: campusId, class_id: classId, is_active: true },
      select: { id: true },
    });
    if (!mapping) {
      this.allocationError(
        ALLOCATION_ERROR_CODES.CAMPUS_CLASS_INACTIVE,
        `Class #${classId} is not active for campus #${campusId}`,
      );
    }
  }

  async assertPlacementAllowed(
    target: PlacementTarget,
    student: PlacementStudentContext,
    tx: TxClient | PrismaService = this.prisma,
  ): Promise<CampusSectionRules> {
    await this.assertCampusClassActive(target.campusId, target.classId, tx);

    const rules = await this.getCampusSectionRules(target, tx);
    if (!rules) {
      this.allocationError(
        ALLOCATION_ERROR_CODES.SECTION_NOT_OFFERED,
        `Section #${target.sectionId} is not offered for class #${target.classId} at campus #${target.campusId}`,
      );
    }
    if (rules.is_active === false) {
      this.allocationError(
        ALLOCATION_ERROR_CODES.SECTION_INACTIVE,
        `Section #${target.sectionId} is inactive for class #${target.classId} at campus #${target.campusId}`,
      );
    }

    this.assertGenderAllowed(rules.gender_mode, student.gender);

    const countsTowardCapacity = student.countsTowardCapacity !== false;
    if (countsTowardCapacity && rules.student_capacity != null) {
      const enrolledCount = await this.countEnrolledOccupants(target, student.studentCc, tx);
      if (enrolledCount >= rules.student_capacity) {
        this.allocationError(
          ALLOCATION_ERROR_CODES.SECTION_FULL,
          `Section is full (${enrolledCount}/${rules.student_capacity} enrolled)`,
          'conflict',
        );
      }
    }

    return rules;
  }

  assertGenderAllowed(
    genderMode: SectionGenderMode,
    rawGender: string | null | undefined,
  ): void {
    if (genderMode === SectionGenderMode.COED) return;

    const normalized = normalizeGender(rawGender);
    if (normalized === 'UNKNOWN') {
      this.allocationError(
        ALLOCATION_ERROR_CODES.STUDENT_GENDER_REQUIRED,
        'Student gender is required for gender-restricted sections',
      );
    }

    if (genderMode === SectionGenderMode.BOYS_ONLY && normalized !== 'MALE') {
      this.allocationError(
        ALLOCATION_ERROR_CODES.SECTION_GENDER_RESTRICTED,
        'This section is boys only',
      );
    }

    if (genderMode === SectionGenderMode.GIRLS_ONLY && normalized !== 'FEMALE') {
      this.allocationError(
        ALLOCATION_ERROR_CODES.SECTION_GENDER_RESTRICTED,
        'This section is girls only',
      );
    }
  }

  async countEnrolledOccupants(
    target: PlacementTarget,
    excludeStudentCc?: number | null,
    tx: TxClient | PrismaService = this.prisma,
  ): Promise<number> {
    return tx.students.count({
      where: {
        campus_id: target.campusId,
        class_id: target.classId,
        section_id: target.sectionId,
        status: student_status.ENROLLED,
        deleted_at: null,
        ...(excludeStudentCc != null ? { cc: { not: excludeStudentCc } } : {}),
      },
    });
  }

  async computeOccupancyStats(
    rules: Pick<CampusSectionRules, 'campus_id' | 'class_id' | 'section_id' | 'student_capacity' | 'gender_mode'>,
    tx: TxClient | PrismaService = this.prisma,
  ): Promise<SectionOccupancyStats> {
    const students = await tx.students.findMany({
      where: {
        campus_id: rules.campus_id,
        class_id: rules.class_id,
        section_id: rules.section_id,
        status: student_status.ENROLLED,
        deleted_at: null,
      },
      select: { gender: true },
    });

    let male_count = 0;
    let female_count = 0;
    let unknown_count = 0;
    let gender_conflict_count = 0;

    for (const s of students) {
      const g = normalizeGender(s.gender);
      if (g === 'MALE') male_count += 1;
      else if (g === 'FEMALE') female_count += 1;
      else unknown_count += 1;

      if (rules.gender_mode === SectionGenderMode.BOYS_ONLY && g !== 'MALE') {
        gender_conflict_count += 1;
      } else if (rules.gender_mode === SectionGenderMode.GIRLS_ONLY && g !== 'FEMALE') {
        gender_conflict_count += 1;
      }
    }

    const enrolled_count = students.length;
    const remaining_seats =
      rules.student_capacity == null
        ? null
        : Math.max(rules.student_capacity - enrolled_count, 0);
    const is_full =
      rules.student_capacity != null && enrolled_count >= rules.student_capacity;
    const capacity_conflict_count =
      rules.student_capacity != null && enrolled_count > rules.student_capacity
        ? enrolled_count - rules.student_capacity
        : 0;

    return {
      enrolled_count,
      male_count,
      female_count,
      unknown_count,
      remaining_seats,
      is_full,
      capacity_conflict_count,
      gender_conflict_count,
    };
  }

  /**
   * Batch occupancy for many campus_sections rows.
   * Key format: `${campusId}:${classId}:${sectionId}`
   */
  async computeOccupancyStatsBatch(
    sections: Array<{
      campus_id: number;
      class_id: number;
      section_id: number;
      student_capacity: number | null;
      gender_mode: SectionGenderMode;
    }>,
  ): Promise<Map<string, SectionOccupancyStats>> {
    const result = new Map<string, SectionOccupancyStats>();
    if (sections.length === 0) return result;

    const campusIds = [...new Set(sections.map((s) => s.campus_id))];
    const students = await this.prisma.students.findMany({
      where: {
        campus_id: { in: campusIds },
        status: student_status.ENROLLED,
        deleted_at: null,
        section_id: { not: null },
        class_id: { not: null },
      },
      select: {
        campus_id: true,
        class_id: true,
        section_id: true,
        gender: true,
      },
    });

    const grouped = new Map<string, Array<{ gender: string | null }>>();
    for (const s of students) {
      if (s.campus_id == null || s.class_id == null || s.section_id == null) continue;
      const key = `${s.campus_id}:${s.class_id}:${s.section_id}`;
      const list = grouped.get(key) ?? [];
      list.push({ gender: s.gender });
      grouped.set(key, list);
    }

    for (const section of sections) {
      const key = `${section.campus_id}:${section.class_id}:${section.section_id}`;
      const roster = grouped.get(key) ?? [];
      let male_count = 0;
      let female_count = 0;
      let unknown_count = 0;
      let gender_conflict_count = 0;

      for (const s of roster) {
        const g = normalizeGender(s.gender);
        if (g === 'MALE') male_count += 1;
        else if (g === 'FEMALE') female_count += 1;
        else unknown_count += 1;

        if (section.gender_mode === SectionGenderMode.BOYS_ONLY && g !== 'MALE') {
          gender_conflict_count += 1;
        } else if (
          section.gender_mode === SectionGenderMode.GIRLS_ONLY &&
          g !== 'FEMALE'
        ) {
          gender_conflict_count += 1;
        }
      }

      const enrolled_count = roster.length;
      result.set(key, {
        enrolled_count,
        male_count,
        female_count,
        unknown_count,
        remaining_seats:
          section.student_capacity == null
            ? null
            : Math.max(section.student_capacity - enrolled_count, 0),
        is_full:
          section.student_capacity != null &&
          enrolled_count >= section.student_capacity,
        capacity_conflict_count:
          section.student_capacity != null &&
          enrolled_count > section.student_capacity
            ? enrolled_count - section.student_capacity
            : 0,
        gender_conflict_count,
      });
    }

    return result;
  }

  /**
   * Resolve whether a placement needs capacity/gender checks.
   * Soft-admission placement that does not set section is skipped.
   */
  shouldValidatePlacement(target: {
    campusId?: number | null;
    classId?: number | null;
    sectionId?: number | null;
  }): target is PlacementTarget {
    return (
      target.campusId != null &&
      target.classId != null &&
      target.sectionId != null
    );
  }
}
