import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { assertClassInScope } from '../../common/staff-scope';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { BulkEnrollDto, CreateTeachingGroupDto, UpdateTeachingGroupDto } from './dto/teaching-groups.dto';
import { ClassPeriodsService } from './class-periods.service';

@Injectable()
export class TeachingGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly classPeriods: ClassPeriodsService,
  ) {}

  private assertCampusAccess(user: IJwtStaffPayload, campusId: number) {
    if (user.campusId && user.campusId !== campusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }
  }

  private groupInclude() {
    return {
      classes: { select: { id: true, description: true, class_code: true, academic_system: true } },
      subjects: { select: { id: true, name: true, code: true, academic_system: true } },
      employee_profiles: { select: { id: true, full_name: true, employee_code: true } },
      campuses: { select: { id: true, campus_name: true, campus_code: true } },
      _count: { select: { student_subject_enrollments: true } },
    } satisfies Prisma.teaching_groupsInclude;
  }

  async list(campusId: number, classId: number, academicYear: string, user: IJwtStaffPayload) {
    this.assertCampusAccess(user, campusId);
    assertClassInScope(user, classId);

    return this.prisma.teaching_groups.findMany({
      where: { campus_id: campusId, class_id: classId, academic_year: academicYear },
      include: this.groupInclude(),
      orderBy: [{ subjects: { name: 'asc' } }, { employee_profiles: { full_name: 'asc' } }],
    });
  }

  async create(dto: CreateTeachingGroupDto, user: IJwtStaffPayload) {
    this.assertCampusAccess(user, dto.campus_id);
    assertClassInScope(user, dto.class_id);

    const [subject, employee, campusClass] = await Promise.all([
      this.prisma.subjects.findFirst({ where: { id: dto.subject_id, is_active: true } }),
      this.prisma.employee_profiles.findUnique({ where: { id: dto.employee_id } }),
      this.prisma.campus_classes.findFirst({
        where: { campus_id: dto.campus_id, class_id: dto.class_id },
      }),
    ]);
    if (!subject) throw new BadRequestException('Subject not found or inactive');
    if (!employee) throw new BadRequestException('Employee not found');
    if (!campusClass) throw new BadRequestException('Class is not offered at this campus');

    const created = await this.prisma.teaching_groups.create({
      data: {
        campus_id: dto.campus_id,
        class_id: dto.class_id,
        subject_id: dto.subject_id,
        employee_id: dto.employee_id,
        academic_year: dto.academic_year,
        label: dto.label?.trim() || null,
      },
      include: this.groupInclude(),
    });

    void this.auditLogs.log({
      entity_type: 'TEACHING_GROUP',
      entity_id: String(created.id),
      action: 'CREATED',
      changed_by: auditActorLabel(user),
      note: `Teaching group created: ${created.subjects.name} — ${created.employee_profiles.full_name} for ${created.classes.description}, academic year ${dto.academic_year}.`,
    });

    return created;
  }

  async update(id: number, dto: UpdateTeachingGroupDto, user: IJwtStaffPayload) {
    const existing = await this.prisma.teaching_groups.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Teaching group not found');
    this.assertCampusAccess(user, existing.campus_id);
    assertClassInScope(user, existing.class_id);

    if (dto.employee_id != null) {
      const employee = await this.prisma.employee_profiles.findUnique({
        where: { id: dto.employee_id },
      });
      if (!employee) throw new BadRequestException('Employee not found');
    }

    const updated = await this.prisma.teaching_groups.update({
      where: { id },
      data: {
        employee_id: dto.employee_id,
        label: dto.label !== undefined ? dto.label?.trim() || null : undefined,
        is_active: dto.is_active,
      },
      include: this.groupInclude(),
    });

    void this.auditLogs.log({
      entity_type: 'TEACHING_GROUP',
      entity_id: String(id),
      action: 'UPDATED',
      changed_by: auditActorLabel(user),
      note: `Teaching group #${id} updated.`,
    });

    return updated;
  }

  async remove(id: number, user: IJwtStaffPayload) {
    const existing = await this.prisma.teaching_groups.findUnique({
      where: { id },
      include: {
        _count: { select: { student_subject_enrollments: true, timetables: true } },
      },
    });
    if (!existing) throw new NotFoundException('Teaching group not found');
    this.assertCampusAccess(user, existing.campus_id);
    assertClassInScope(user, existing.class_id);

    const hasDependents =
      existing._count.student_subject_enrollments > 0 || existing._count.timetables > 0;

    if (hasDependents) {
      await this.prisma.teaching_groups.update({
        where: { id },
        data: { is_active: false },
      });
      void this.auditLogs.log({
        entity_type: 'TEACHING_GROUP',
        entity_id: String(id),
        action: 'DEACTIVATED',
        changed_by: auditActorLabel(user),
        note: `Teaching group #${id} deactivated (has enrollments/timetable data, not hard-deleted).`,
      });
      return { deactivated: true };
    }

    await this.prisma.teaching_groups.delete({ where: { id } });
    void this.auditLogs.log({
      entity_type: 'TEACHING_GROUP',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: auditActorLabel(user),
      note: `Teaching group #${id} deleted.`,
    });
    return { deleted: true };
  }

  private async assertGroupAccess(id: number, user: IJwtStaffPayload) {
    const group = await this.prisma.teaching_groups.findUnique({ where: { id } });
    if (!group) throw new NotFoundException('Teaching group not found');
    this.assertCampusAccess(user, group.campus_id);
    assertClassInScope(user, group.class_id);
    return group;
  }

  async getRoster(id: number, user: IJwtStaffPayload) {
    await this.assertGroupAccess(id, user);
    return this.prisma.student_subject_enrollments.findMany({
      where: { teaching_group_id: id },
      include: {
        students: {
          select: {
            cc: true,
            full_name: true,
            gr_number: true,
            class_id: true,
            section_id: true,
            sections: { select: { id: true, description: true } },
          },
        },
      },
      orderBy: { students: { full_name: 'asc' } },
    });
  }

  async bulkEnroll(id: number, dto: BulkEnrollDto, user: IJwtStaffPayload) {
    const group = await this.assertGroupAccess(id, user);

    const students = await this.prisma.students.findMany({
      where: { cc: { in: dto.student_ids } },
      select: { cc: true, class_id: true },
    });
    const foundIds = new Set(students.map((s) => s.cc));
    const missing = dto.student_ids.filter((sid) => !foundIds.has(sid));
    if (missing.length > 0) {
      throw new BadRequestException(`Students not found: ${missing.join(', ')}`);
    }
    const wrongClass = students.filter((s) => s.class_id !== group.class_id);
    if (wrongClass.length > 0) {
      throw new ConflictException(
        `Students not in class #${group.class_id}: ${wrongClass.map((s) => s.cc).join(', ')}`,
      );
    }

    await this.prisma.student_subject_enrollments.createMany({
      data: dto.student_ids.map((studentId) => ({
        student_id: studentId,
        teaching_group_id: id,
        academic_year: dto.academic_year,
      })),
      skipDuplicates: true,
    });

    void this.auditLogs.log({
      entity_type: 'TEACHING_GROUP',
      entity_id: String(id),
      action: 'ENROLLED',
      changed_by: auditActorLabel(user),
      note: `Enrolled ${dto.student_ids.length} student(s) into teaching group #${id} for ${dto.academic_year}.`,
    });

    return this.getRoster(id, user);
  }

  async removeEnrollment(id: number, studentId: number, user: IJwtStaffPayload) {
    await this.assertGroupAccess(id, user);

    const deleted = await this.prisma.student_subject_enrollments.deleteMany({
      where: { teaching_group_id: id, student_id: studentId },
    });
    if (deleted.count === 0) {
      throw new NotFoundException('Enrollment not found');
    }

    void this.auditLogs.log({
      entity_type: 'TEACHING_GROUP',
      entity_id: String(id),
      action: 'UNENROLLED',
      changed_by: auditActorLabel(user),
      note: `Removed student #${studentId} from teaching group #${id}.`,
    });

    return { removed: true };
  }

  async listStudentSubjectEnrollments(studentId: number) {
    return this.prisma.student_subject_enrollments.findMany({
      where: { student_id: studentId },
      include: {
        teaching_groups: {
          include: {
            subjects: { select: { id: true, name: true, code: true } },
            employee_profiles: { select: { id: true, full_name: true } },
            classes: { select: { id: true, description: true } },
          },
        },
      },
      orderBy: { academic_year: 'desc' },
    });
  }

  private deriveCurrentAcademicYear(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth(); // 0-indexed; Aug = 7
    const startYear = month >= 7 ? year : year - 1;
    return `${startYear}-${startYear + 1}`;
  }

  /** A student's own weekly schedule, merged across every teaching group
   * they're enrolled in (each subject can have a different teacher/room). */
  async getStudentWeeklySlots(studentId: number) {
    const academicYear = this.deriveCurrentAcademicYear();

    const enrollments = await this.prisma.student_subject_enrollments.findMany({
      where: { student_id: studentId, academic_year: academicYear },
      select: { teaching_group_id: true },
    });
    const groupIds = [...new Set(enrollments.map((e) => e.teaching_group_id))];
    if (groupIds.length === 0) return { blocks: [] };

    const timetables = await this.prisma.timetables.findMany({
      where: { teaching_group_id: { in: groupIds }, is_active: true, academic_year: academicYear },
      select: { id: true, teaching_group_id: true },
    });
    const timetableIds = timetables.map((t) => t.id);
    if (timetableIds.length === 0) return { blocks: [] };

    const slots = await this.prisma.timetable_slots.findMany({
      where: { timetable_id: { in: timetableIds } },
      include: {
        subjects: { select: { id: true, name: true, code: true } },
        employee_profiles: { select: { id: true, full_name: true } },
        timetables: {
          select: {
            campus_id: true,
            class_id: true,
            teaching_group_id: true,
            teaching_groups: { select: { id: true, label: true } },
          },
        },
      },
      orderBy: [{ day_of_week: 'asc' }, { block_number: 'asc' }, { slot_order: 'asc' }],
    });

    // Each teaching group's class may run a different bell schedule, so
    // times are resolved per (campus, class, block) rather than off one
    // shared global list.
    const periods = await this.classPeriods.resolveMany(
      slots.map((slot) => ({
        campus_id: slot.timetables.campus_id,
        class_id: slot.timetables.class_id,
        block_number: slot.block_number,
      })),
    );

    return {
      blocks: slots.map((slot) => {
        const period = periods.get(
          `${slot.timetables.campus_id}:${slot.timetables.class_id}:${slot.block_number}`,
        );
        return {
          id: slot.id,
          day_of_week: slot.day_of_week,
          block_number: slot.block_number,
          start_time: period?.start_time ?? null,
          end_time: period?.end_time ?? null,
          label: period?.label ?? null,
          room: slot.room,
          subject: slot.subjects,
          teacher: slot.employee_profiles,
          campus_id: slot.timetables.campus_id,
          class_id: slot.timetables.class_id,
          teaching_group_id: slot.timetables.teaching_group_id,
          teaching_group_label: slot.timetables.teaching_groups?.label ?? null,
        };
      }),
    };
  }
}
