import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceSource,
  CheckInSource,
  ClassSessionRescheduleStatus,
  StaffAttendanceStatus,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { assertClassInScope } from '../../common/staff-scope';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { ClassPeriodsService } from '../timetables/class-periods.service';
import { StaffLessonExcuseService } from './staff-lesson-excuse.service';
import {
  CreateStaffLessonRescheduleDto,
  ListStaffLessonReschedulesQueryDto,
  ListStaffLessonTeachersQueryDto,
  StaffLessonSourceDateStatusQueryDto,
  TeacherSlotsQueryDto,
} from './dto/staff-lesson-reschedules.dto';

export const O_LEVEL_CLASS_IDS = [12, 13, 14] as const;
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

@Injectable()
export class StaffLessonReschedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly classPeriods: ClassPeriodsService,
    private readonly staffExcuse: StaffLessonExcuseService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private assertCampusAccess(user: IJwtStaffPayload, campusId: number) {
    if (user.role === 'SUPER_ADMIN') return;
    if (user.campusId != null && user.campusId !== campusId) {
      throw new ForbiddenException('Campus out of scope');
    }
  }

  private parseDate(dateStr: string): Date {
    const normalized = dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00.000Z`;
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    return d;
  }

  private academicYearStartDate(academicYear: string): Date {
    const [startYear] = academicYear.split('-').map(Number);
    return new Date(Date.UTC(startYear, 7, 1));
  }

  static defaultSourceDate(before: Date, weekday: number): Date {
    const d = new Date(before);
    d.setUTCHours(0, 0, 0, 0);
    const diff = (d.getUTCDay() - weekday + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() - diff);
    return d;
  }

  private includeRow() {
    return {
      employee_profiles: {
        select: { id: true, full_name: true, employee_code: true },
      },
      classes: { select: { id: true, class_code: true, description: true } },
      sections: { select: { id: true, description: true } },
      source_timetable_slot: {
        select: {
          id: true,
          day_of_week: true,
          block_number: true,
          subjects: { select: { id: true, name: true, code: true } },
        },
      },
      makeup_timetable_slot: {
        select: {
          id: true,
          day_of_week: true,
          block_number: true,
        },
      },
      users: { select: { id: true, full_name: true } },
    };
  }

  private isOLevelSectionTimetable(timetable: {
    class_id: number;
    section_id: number | null;
    teaching_group_id: number | null;
  }): boolean {
    return (
      O_LEVEL_CLASS_IDS.includes(timetable.class_id as (typeof O_LEVEL_CLASS_IDS)[number]) &&
      timetable.section_id != null &&
      timetable.teaching_group_id == null
    );
  }

  async listTeachers(query: ListStaffLessonTeachersQueryDto, user: IJwtStaffPayload) {
    this.assertCampusAccess(user, query.campus_id);
    const academicYear =
      query.academic_year ??
      (await this.prisma.teaching_groups.findFirst({
        select: { academic_year: true },
        orderBy: { academic_year: 'desc' },
      }))?.academic_year ??
      '2026-2027';

    const slots = await this.prisma.timetable_slots.findMany({
      where: {
        timetables: {
          is_active: true,
          campus_id: query.campus_id,
          academic_year: academicYear,
          class_id: { in: [...O_LEVEL_CLASS_IDS] },
          section_id: { not: null },
          teaching_group_id: null,
        },
        employee_profiles: {
          employment_status: 'ACTIVE',
          check_in_source: CheckInSource.TIMETABLE,
        },
      },
      include: {
        subjects: { select: { name: true } },
        employee_profiles: {
          select: {
            id: true,
            full_name: true,
            employee_code: true,
            campus_id: true,
          },
        },
        timetables: {
          select: {
            class_id: true,
            classes: { select: { class_code: true } },
            sections: { select: { description: true } },
          },
        },
      },
      orderBy: [{ employee_id: 'asc' }, { day_of_week: 'asc' }, { block_number: 'asc' }],
    });

    const byEmployee = new Map<
      number,
      {
        employee_id: number;
        full_name: string | null;
        employee_code: string | null;
        campus_id: number;
        slot_count: number;
        classes: Array<{
          class_code: string;
          section_code: string;
          subject_name: string;
          day_label: string;
          time_label: string;
        }>;
      }
    >();

    for (const slot of slots) {
      const emp = slot.employee_profiles;
      if (!emp) continue;
      if (query.search?.trim()) {
        const q = query.search.trim().toLowerCase();
        const hay = `${emp.full_name ?? ''} ${emp.employee_code ?? ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      let row = byEmployee.get(emp.id);
      if (!row) {
        row = {
          employee_id: emp.id,
          full_name: emp.full_name,
          employee_code: emp.employee_code,
          campus_id: query.campus_id,
          slot_count: 0,
          classes: [],
        };
        byEmployee.set(emp.id, row);
      }
      row.slot_count += 1;
      row.classes.push({
        class_code: slot.timetables.classes.class_code,
        section_code: slot.timetables.sections?.description ?? '—',
        subject_name: slot.subjects.name,
        day_label: WEEKDAY_NAMES[slot.day_of_week],
        time_label: `Period ${slot.block_number}`,
      });
    }

    return [...byEmployee.values()].sort((a, b) =>
      (a.full_name ?? '').localeCompare(b.full_name ?? ''),
    );
  }

  async getTeacherSlots(
    employeeId: number,
    query: TeacherSlotsQueryDto,
    user: IJwtStaffPayload,
  ) {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { id: true, campus_id: true, check_in_source: true, employment_status: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    if (employee.campus_id) this.assertCampusAccess(user, employee.campus_id);
    if (employee.check_in_source !== CheckInSource.TIMETABLE) {
      throw new BadRequestException('Employee is not on timetable payroll');
    }

    const academicYear =
      query.academic_year ??
      (await this.prisma.teaching_groups.findFirst({
        select: { academic_year: true },
        orderBy: { academic_year: 'desc' },
      }))?.academic_year ??
      '2026-2027';

    const slots = await this.prisma.timetable_slots.findMany({
      where: {
        employee_id: employeeId,
        timetables: {
          is_active: true,
          academic_year: academicYear,
          class_id: { in: [...O_LEVEL_CLASS_IDS] },
          section_id: { not: null },
          teaching_group_id: null,
        },
      },
      include: {
        subjects: { select: { id: true, name: true, code: true } },
        timetables: {
          select: {
            id: true,
            campus_id: true,
            class_id: true,
            section_id: true,
            academic_year: true,
            effective_from: true,
            classes: { select: { class_code: true } },
            sections: { select: { description: true } },
          },
        },
      },
      orderBy: [{ day_of_week: 'asc' }, { block_number: 'asc' }],
    });

    const campusId = slots[0]?.timetables.campus_id ?? employee.campus_id;
    const classId = slots[0]?.timetables.class_id;
    const periods =
      campusId && classId ? await this.classPeriods.list(campusId, classId) : [];
    const periodByBlock = new Map(periods.map((p) => [p.block_number, p]));

    return {
      academic_year: academicYear,
      timetable_effective_from: slots[0]?.timetables.effective_from
        ?.toISOString()
        .slice(0, 10) ?? null,
      slots: slots.map((slot) => {
        const period = periodByBlock.get(slot.block_number);
        const effectiveFrom = slot.timetables.effective_from;
        const scheduleStart = new Date(
          Math.max(
            this.academicYearStartDate(slot.timetables.academic_year).getTime(),
            effectiveFrom.getTime(),
          ),
        );
        let defaultSource = StaffLessonReschedulesService.defaultSourceDate(
          new Date(),
          slot.day_of_week,
        );
        if (defaultSource.getTime() < scheduleStart.getTime()) {
          defaultSource = new Date(scheduleStart);
        }
        return {
          id: slot.id,
          timetable_id: slot.timetable_id,
          campus_id: slot.timetables.campus_id,
          class_id: slot.timetables.class_id,
          section_id: slot.timetables.section_id,
          class_code: slot.timetables.classes.class_code,
          section_code: slot.timetables.sections?.description ?? '—',
          day_of_week: slot.day_of_week,
          day_label: WEEKDAY_NAMES[slot.day_of_week],
          block_number: slot.block_number,
          subject: slot.subjects,
          time_label: period?.label ?? `Period ${slot.block_number}`,
          default_source_date: defaultSource.toISOString().slice(0, 10),
          timetable_effective_from: effectiveFrom.toISOString().slice(0, 10),
        };
      }),
    };
  }

  async getSourceDateStatus(
    query: StaffLessonSourceDateStatusQueryDto,
    user: IJwtStaffPayload,
  ) {
    const sourceDate = this.parseDate(query.source_date);
    const slot = await this.prisma.timetable_slots.findUnique({
      where: { id: query.source_timetable_slot_id },
      include: {
        timetables: {
          select: { campus_id: true, class_id: true },
        },
      },
    });
    if (!slot || slot.employee_id !== query.employee_id) {
      throw new BadRequestException('Slot does not belong to this teacher');
    }
    this.assertCampusAccess(user, slot.timetables.campus_id);
    assertClassInScope(user, slot.timetables.class_id);

    const staffRow = await this.prisma.attendance_staff_daily.findUnique({
      where: {
        employee_id_date: { employee_id: query.employee_id, date: sourceDate },
      },
      select: { status: true, source: true, notes: true },
    });

    return {
      source_date: sourceDate.toISOString().slice(0, 10),
      staff_status: staffRow?.status ?? null,
      staff_source: staffRow?.source ?? null,
      staff_notes: staffRow?.notes ?? null,
    };
  }

  async findAll(query: ListStaffLessonReschedulesQueryDto, user: IJwtStaffPayload) {
    const where: Record<string, unknown> = {};
    if (query.campus_id) {
      this.assertCampusAccess(user, query.campus_id);
      where.campus_id = query.campus_id;
    } else if (user.campusId && user.role !== 'SUPER_ADMIN') {
      where.campus_id = user.campusId;
    }
    if (query.employee_id) where.employee_id = query.employee_id;
    if (query.status) where.status = query.status;
    if (query.from || query.to) {
      where.source_date = {};
      if (query.from) {
        (where.source_date as Record<string, Date>).gte = this.parseDate(query.from);
      }
      if (query.to) {
        (where.source_date as Record<string, Date>).lte = this.parseDate(query.to);
      }
    }

    return this.prisma.staff_lesson_reschedules.findMany({
      where,
      include: this.includeRow(),
      orderBy: [{ status: 'asc' }, { source_date: 'desc' }],
    });
  }

  async findOne(id: number, user: IJwtStaffPayload) {
    const row = await this.prisma.staff_lesson_reschedules.findUnique({
      where: { id },
      include: this.includeRow(),
    });
    if (!row) throw new NotFoundException('Staff lesson reschedule not found');
    this.assertCampusAccess(user, row.campus_id);
    assertClassInScope(user, row.class_id);
    return row;
  }

  async create(dto: CreateStaffLessonRescheduleDto, user: IJwtStaffPayload) {
    this.assertCampusAccess(user, dto.campus_id);
    assertClassInScope(user, dto.class_id);

    const sourceDate = this.parseDate(dto.source_date);
    const makeupDate = this.parseDate(dto.makeup_date);

    const slot = await this.prisma.timetable_slots.findUnique({
      where: { id: dto.source_timetable_slot_id },
      include: { timetables: true },
    });
    if (!slot || slot.employee_id !== dto.employee_id) {
      throw new BadRequestException('Source slot does not belong to this teacher');
    }
    if (!this.isOLevelSectionTimetable(slot.timetables)) {
      throw new BadRequestException('Source slot must be on an O-Level section timetable');
    }
    if (
      slot.timetables.campus_id !== dto.campus_id ||
      slot.timetables.class_id !== dto.class_id ||
      slot.timetables.section_id !== dto.section_id
    ) {
      throw new BadRequestException('Slot scope does not match request');
    }
    if (slot.day_of_week !== sourceDate.getUTCDay()) {
      throw new BadRequestException('Source date does not match slot weekday');
    }
    if (sourceDate.getTime() < slot.timetables.effective_from.getTime()) {
      throw new BadRequestException('Source date is before timetable effective_from');
    }
    if (makeupDate.getTime() <= sourceDate.getTime()) {
      throw new BadRequestException('Makeup date must be after source date');
    }

    if (dto.makeup_timetable_slot_id) {
      const makeupSlot = await this.prisma.timetable_slots.findUnique({
        where: { id: dto.makeup_timetable_slot_id },
        include: { timetables: true },
      });
      if (!makeupSlot || makeupSlot.employee_id !== dto.employee_id) {
        throw new BadRequestException('Makeup slot does not belong to this teacher');
      }
    }

    const existing = await this.prisma.staff_lesson_reschedules.findUnique({
      where: {
        source_timetable_slot_id_source_date: {
          source_timetable_slot_id: dto.source_timetable_slot_id,
          source_date: sourceDate,
        },
      },
    });
    if (existing && existing.status !== ClassSessionRescheduleStatus.CANCELLED) {
      throw new BadRequestException('A reschedule already exists for this slot and date');
    }

    const row = existing
      ? await this.prisma.staff_lesson_reschedules.update({
          where: { id: existing.id },
          data: {
            makeup_date: makeupDate,
            makeup_timetable_slot_id: dto.makeup_timetable_slot_id ?? null,
            status: ClassSessionRescheduleStatus.SCHEDULED,
            notes: dto.notes ?? null,
            created_by_id: user.sub,
          },
          include: this.includeRow(),
        })
      : await this.prisma.staff_lesson_reschedules.create({
          data: {
            employee_id: dto.employee_id,
            campus_id: dto.campus_id,
            class_id: dto.class_id,
            section_id: dto.section_id,
            source_timetable_slot_id: dto.source_timetable_slot_id,
            source_date: sourceDate,
            makeup_date: makeupDate,
            makeup_timetable_slot_id: dto.makeup_timetable_slot_id ?? null,
            status: ClassSessionRescheduleStatus.SCHEDULED,
            notes: dto.notes ?? null,
            created_by_id: user.sub,
          },
          include: this.includeRow(),
        });

    void this.auditLogs.log({
      entity_type: 'STAFF_LESSON_RESCHEDULE',
      entity_id: String(row.id),
      action: 'CREATED',
      changed_by: auditActorLabel(user),
      note: `Staff lesson reschedule #${row.id} created.`,
    });

    return row;
  }

  async complete(id: number, user: IJwtStaffPayload) {
    const row = await this.findOne(id, user);
    if (row.status !== ClassSessionRescheduleStatus.SCHEDULED) {
      throw new BadRequestException('Only scheduled reschedules can be completed');
    }

    const { staffExcused, staffExcuseWarning } =
      await this.staffExcuse.excuseTeacherForMissedLesson({
        employeeId: row.employee_id,
        sourceDate: row.source_date,
        makeupDate: row.makeup_date,
        sourceSlotId: row.source_timetable_slot_id,
        campusId: row.campus_id,
      });

    const updated = await this.prisma.staff_lesson_reschedules.update({
      where: { id },
      data: { status: ClassSessionRescheduleStatus.COMPLETED },
      include: this.includeRow(),
    });

    void this.auditLogs.log({
      entity_type: 'STAFF_LESSON_RESCHEDULE',
      entity_id: String(id),
      action: 'UPDATED',
      field: 'status',
      old_value: 'SCHEDULED',
      new_value: 'COMPLETED',
      changed_by: auditActorLabel(user),
      note: staffExcused
        ? `Staff excused on ${this.staffExcuse.formatDateLabel(row.source_date)}`
        : staffExcuseWarning ?? 'Completed without staff excuse',
    });

    return { reschedule: updated, staffExcused, staffExcuseWarning };
  }

  async cancel(id: number, user: IJwtStaffPayload) {
    const row = await this.findOne(id, user);
    if (row.status !== ClassSessionRescheduleStatus.SCHEDULED) {
      throw new BadRequestException('Only scheduled reschedules can be cancelled');
    }

    const updated = await this.prisma.staff_lesson_reschedules.update({
      where: { id },
      data: { status: ClassSessionRescheduleStatus.CANCELLED },
      include: this.includeRow(),
    });

    void this.auditLogs.log({
      entity_type: 'STAFF_LESSON_RESCHEDULE',
      entity_id: String(id),
      action: 'UPDATED',
      field: 'status',
      old_value: 'SCHEDULED',
      new_value: 'CANCELLED',
      changed_by: auditActorLabel(user),
    });

    return updated;
  }

  async reverse(id: number, user: IJwtStaffPayload) {
    const row = await this.findOne(id, user);
    if (row.status !== ClassSessionRescheduleStatus.COMPLETED) {
      throw new BadRequestException('Only completed reschedules can be reversed');
    }

    await this.prisma.$transaction(async (tx) => {
      const staffRow = await tx.attendance_staff_daily.findUnique({
        where: {
          employee_id_date: { employee_id: row.employee_id, date: row.source_date },
        },
      });
      if (
        staffRow?.status === StaffAttendanceStatus.EXCUSED &&
        staffRow.source === AttendanceSource.SYSTEM &&
        staffRow.notes?.includes('Makeup class held')
      ) {
        await tx.attendance_staff_daily.delete({ where: { id: staffRow.id } });
      }

      await tx.staff_lesson_reschedules.update({
        where: { id },
        data: { status: ClassSessionRescheduleStatus.CANCELLED },
      });
    });

    void this.auditLogs.log({
      entity_type: 'STAFF_LESSON_RESCHEDULE',
      entity_id: String(id),
      action: 'UPDATED',
      field: 'status',
      old_value: 'COMPLETED',
      new_value: 'CANCELLED',
      changed_by: auditActorLabel(user),
      note: `Staff lesson reschedule #${id} reversed.`,
    });

    return this.findOne(id, user);
  }
}
