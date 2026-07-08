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
import { UpsertSlotDto } from './dto/timetables.dto';

@Injectable()
export class TimetablesService {
  constructor(private readonly prisma: PrismaService) {}

  private assertCampusAccess(user: IJwtStaffPayload, campusId: number) {
    if (user.campusId && user.campusId !== campusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }
  }

  private async assertCampusSection(
    campusId: number,
    classId: number,
    sectionId: number,
  ) {
    const link = await this.prisma.campus_sections.findFirst({
      where: { campus_id: campusId, class_id: classId, section_id: sectionId },
    });
    if (!link) {
      throw new BadRequestException(
        'Section is not offered for this class at this campus',
      );
    }
  }

  private slotInclude() {
    return {
      subjects: { select: { id: true, name: true, code: true, academic_system: true } },
      employee_profiles: {
        select: { id: true, full_name: true, employee_code: true },
      },
    } satisfies Prisma.timetable_slotsInclude;
  }

  private timetableInclude() {
    return {
      classes: {
        select: { id: true, description: true, class_code: true, academic_system: true },
      },
      sections: { select: { id: true, description: true } },
      campuses: { select: { id: true, campus_name: true, campus_code: true } },
      timetable_slots: {
        include: this.slotInclude(),
        orderBy: [
          { day_of_week: 'asc' as const },
          { block_number: 'asc' as const },
          { slot_order: 'asc' as const },
        ],
      },
    } satisfies Prisma.timetablesInclude;
  }

  async listBlocks() {
    return this.prisma.timetable_blocks.findMany({
      orderBy: { block_number: 'asc' },
    });
  }

  private deriveAcademicYear(date: Date): string {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth(); // 0-indexed; Aug = 7
    const startYear = month >= 7 ? year : year - 1;
    return `${startYear}-${startYear + 1}`;
  }

  private async resolveActiveTimetable(
    campusId: number,
    classId: number,
    sectionId: number,
    date: Date,
  ) {
    const academicYear = this.deriveAcademicYear(date);
    return this.prisma.timetables.findFirst({
      where: {
        campus_id: campusId,
        class_id: classId,
        section_id: sectionId,
        is_active: true,
        academic_year: academicYear,
      },
      orderBy: { effective_from: 'desc' },
    });
  }

  async getDaySlots(
    campusId: number,
    classId: number,
    sectionId: number,
    dateStr: string,
    user?: IJwtStaffPayload,
  ) {
    if (user) {
      this.assertCampusAccess(user, campusId);
      assertClassInScope(user, classId);
    }
    await this.assertCampusSection(campusId, classId, sectionId);

    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    date.setUTCHours(0, 0, 0, 0);

    const dayOfWeek = date.getUTCDay();
    const [blocks, timetable] = await Promise.all([
      this.listBlocks(),
      this.resolveActiveTimetable(campusId, classId, sectionId, date),
    ]);

    const slots = timetable
      ? await this.prisma.timetable_slots.findMany({
          where: { timetable_id: timetable.id, day_of_week: dayOfWeek },
          include: this.slotInclude(),
          orderBy: [{ block_number: 'asc' }, { slot_order: 'asc' }],
        })
      : [];

    const slotsByBlock = new Map<number, typeof slots>();
    for (const slot of slots) {
      const list = slotsByBlock.get(slot.block_number) ?? [];
      list.push(slot);
      slotsByBlock.set(slot.block_number, list);
    }

    return {
      dayOfWeek,
      blocks: blocks.map((block) => ({
        block_number: block.block_number,
        start_time: block.start_time,
        end_time: block.end_time,
        label: block.label,
        slots: (slotsByBlock.get(block.block_number) ?? []).map((slot) => ({
          id: slot.id,
          slot_order: slot.slot_order,
          subject: slot.subjects,
          employee: slot.employee_profiles,
        })),
      })),
    };
  }

  async getGrid(
    campusId: number,
    classId: number,
    sectionId: number,
    academicYear: string,
    user: IJwtStaffPayload,
  ) {
    this.assertCampusAccess(user, campusId);
    assertClassInScope(user, classId);
    await this.assertCampusSection(campusId, classId, sectionId);

    const [blocks, timetable] = await Promise.all([
      this.listBlocks(),
      this.prisma.timetables.findUnique({
        where: {
          campus_id_class_id_section_id_academic_year: {
            campus_id: campusId,
            class_id: classId,
            section_id: sectionId,
            academic_year: academicYear,
          },
        },
        include: this.timetableInclude(),
      }),
    ]);

    return {
      timetable,
      blocks,
      slots: timetable?.timetable_slots ?? [],
    };
  }

  async getOrCreate(
    campusId: number,
    classId: number,
    sectionId: number,
    academicYear: string,
    user: IJwtStaffPayload,
  ) {
    this.assertCampusAccess(user, campusId);
    assertClassInScope(user, classId);
    await this.assertCampusSection(campusId, classId, sectionId);

    const existing = await this.prisma.timetables.findUnique({
      where: {
        campus_id_class_id_section_id_academic_year: {
          campus_id: campusId,
          class_id: classId,
          section_id: sectionId,
          academic_year: academicYear,
        },
      },
      include: this.timetableInclude(),
    });
    if (existing) return existing;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    return this.prisma.timetables.create({
      data: {
        campus_id: campusId,
        class_id: classId,
        section_id: sectionId,
        academic_year: academicYear,
        effective_from: today,
        is_active: true,
        created_by: user.sub,
      },
      include: this.timetableInclude(),
    });
  }

  async upsertSlot(timetableId: number, dto: UpsertSlotDto, user: IJwtStaffPayload) {
    const timetable = await this.prisma.timetables.findUnique({
      where: { id: timetableId },
    });
    if (!timetable) throw new NotFoundException('Timetable not found');

    this.assertCampusAccess(user, timetable.campus_id);
    assertClassInScope(user, timetable.class_id);

    const subject = await this.prisma.subjects.findFirst({
      where: { id: dto.subject_id, is_active: true },
    });
    if (!subject) throw new BadRequestException('Subject not found or inactive');

    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: dto.employee_id },
    });
    if (!employee) throw new BadRequestException('Employee not found');

    if (dto.slot_order === 2) {
      const primary = await this.prisma.timetable_slots.findUnique({
        where: {
          timetable_id_day_of_week_block_number_slot_order: {
            timetable_id: timetableId,
            day_of_week: dto.day_of_week,
            block_number: dto.block_number,
            slot_order: 1,
          },
        },
      });
      if (!primary) {
        throw new BadRequestException(
          'Cannot add a split slot before the primary slot (slot_order=1) exists',
        );
      }
    }

    // Reject if teacher already has a different slot at this day+block
    // (another timetable's active schedule, or the other split in this cell).
    const conflict = await this.prisma.timetable_slots.findFirst({
      where: {
        employee_id: dto.employee_id,
        day_of_week: dto.day_of_week,
        block_number: dto.block_number,
        NOT: {
          AND: [
            { timetable_id: timetableId },
            { slot_order: dto.slot_order },
          ],
        },
        OR: [
          { timetable_id: timetableId },
          { timetables: { is_active: true } },
        ],
      },
    });
    if (conflict) {
      throw new ConflictException(
        `Teacher is already scheduled at this day/block (timetable #${conflict.timetable_id})`,
      );
    }

    return this.prisma.timetable_slots.upsert({
      where: {
        timetable_id_day_of_week_block_number_slot_order: {
          timetable_id: timetableId,
          day_of_week: dto.day_of_week,
          block_number: dto.block_number,
          slot_order: dto.slot_order,
        },
      },
      create: {
        timetable_id: timetableId,
        day_of_week: dto.day_of_week,
        block_number: dto.block_number,
        slot_order: dto.slot_order,
        subject_id: dto.subject_id,
        employee_id: dto.employee_id,
        room: dto.room?.trim() || null,
      },
      update: {
        subject_id: dto.subject_id,
        employee_id: dto.employee_id,
        room: dto.room?.trim() || null,
      },
      include: this.slotInclude(),
    });
  }

  async deleteSlot(slotId: number, user: IJwtStaffPayload) {
    const slot = await this.prisma.timetable_slots.findUnique({
      where: { id: slotId },
      include: { timetables: true },
    });
    if (!slot) throw new NotFoundException('Slot not found');

    this.assertCampusAccess(user, slot.timetables.campus_id);
    assertClassInScope(user, slot.timetables.class_id);

    if (slot.slot_order === 1) {
      await this.prisma.timetable_slots.deleteMany({
        where: {
          timetable_id: slot.timetable_id,
          day_of_week: slot.day_of_week,
          block_number: slot.block_number,
        },
      });
      return { deleted: true, cascaded: true };
    }

    await this.prisma.timetable_slots.delete({ where: { id: slotId } });
    return { deleted: true, cascaded: false };
  }

  async listTeacherWeeklySlots(employeeId: number, academicYear?: string) {
    return this.prisma.timetable_slots.findMany({
      where: {
        employee_id: employeeId,
        timetables: {
          is_active: true,
          ...(academicYear ? { academic_year: academicYear } : {}),
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
            classes: { select: { id: true, description: true, class_code: true } },
            sections: { select: { id: true, description: true } },
          },
        },
      },
      orderBy: [
        { day_of_week: 'asc' },
        { block_number: 'asc' },
        { slot_order: 'asc' },
      ],
    });
  }
}
