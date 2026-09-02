import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceSource,
  ClassSessionRescheduleStatus,
  RollRecordStatus,
  RollSessionKind,
  StaffAttendanceStatus,
  student_status,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { assertClassInScope } from '../../common/staff-scope';
import {
  CreateClassRescheduleDto,
  EligibleSlotsQueryDto,
  ListClassReschedulesQueryDto,
  SourceDateHoldStatusQueryDto,
} from './dto/class-session-reschedules.dto';
import { RollSessionsService } from './roll-sessions.service';
import { ClassPeriodsService } from '../timetables/class-periods.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import {
  CalendarDayResolverService,
  ResolvedCalendarDay,
} from '../hr/calendar/calendar-day-resolver.service';
import { StaffLessonExcuseService } from './staff-lesson-excuse.service';

const ENROLLED: student_status = 'ENROLLED';
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type SourceDateHoldStatus =
  | 'held'
  | 'missed'
  | 'off_day'
  | 'skipped'
  | 'upcoming';

export type SourceDatePresentStudent = {
  cc: number;
  full_name: string;
  gr_number: string | null;
};

export type SourceDatePresentBySlot = {
  slot_id: number;
  period: number;
  students: SourceDatePresentStudent[];
};

export type SourceDateHoldStatusRow = {
  date: string;
  hold_status: SourceDateHoldStatus;
  held: boolean;
  present_by_slot?: SourceDatePresentBySlot[];
};

export type RescheduleCompletionResult = {
  sourceCount: number;
  excusedStudentCount: number;
  absentStudentCount: number;
  staffExcusedDays: number;
  staffExcuseWarnings: string[];
};

@Injectable()
export class ClassSessionReschedulesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => RollSessionsService))
    private readonly rollSessions: RollSessionsService,
    private readonly classPeriods: ClassPeriodsService,
    private readonly auditLogs: AuditLogsService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly staffLessonExcuse: StaffLessonExcuseService,
  ) {}

  /** Same Saturday exception as roll-sessions.service — A-Level roll call runs Sat. */
  private isRollCallWorkingDay(
    dayResolved: ResolvedCalendarDay,
    sessionDate: Date,
  ): boolean {
    if (dayResolved.isWorkingDay) return true;
    return (
      dayResolved.source === 'DEFAULT' &&
      dayResolved.dayType === 'WEEKEND' &&
      sessionDate.getUTCDay() === 6
    );
  }

  private academicYearStartDate(academicYear: string): Date {
    const [startYear] = academicYear.split('-').map(Number);
    return new Date(Date.UTC(startYear, 7, 1));
  }

  private parseDate(dateStr: string): Date {
    const normalized = dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00.000Z`;
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    return d;
  }

  /** Remove empty draft makeup roll sessions left behind after moving reschedules. */
  private async cleanupOrphanMakeupSession(makeupSessionId: number | null | undefined) {
    if (!makeupSessionId) return;
    const remaining = await this.prisma.class_session_reschedules.count({
      where: { makeup_roll_session_id: makeupSessionId, status: 'PENDING' },
    });
    if (remaining > 0) return;

    const session = await this.prisma.attendance_roll_sessions.findUnique({
      where: { id: makeupSessionId },
    });
    if (
      !session ||
      session.session_kind !== RollSessionKind.MAKEUP ||
      session.status !== 'DRAFT'
    ) {
      return;
    }

    await this.prisma.attendance_roll_sessions.delete({ where: { id: makeupSessionId } });
  }

  private async reattachPendingSourceRow(
    existing: {
      id: number;
      makeup_roll_session_id: number | null;
    },
    makeupSessionId: number,
    dto: {
      makeup_date: Date;
      makeup_period: number;
      makeup_timetable_slot_id?: number | null;
    },
  ) {
    const previousSessionId = existing.makeup_roll_session_id;
    const updated = await this.prisma.class_session_reschedules.update({
      where: { id: existing.id },
      data: {
        makeup_roll_session_id: makeupSessionId,
        makeup_date: dto.makeup_date,
        makeup_period: dto.makeup_period,
        makeup_timetable_slot_id: dto.makeup_timetable_slot_id ?? null,
      },
    });
    if (previousSessionId && previousSessionId !== makeupSessionId) {
      await this.cleanupOrphanMakeupSession(previousSessionId);
    }
    return updated;
  }

  private assertCampusAccess(user: IJwtStaffPayload, campusId: number) {
    if (user.campusId && user.campusId !== campusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }
  }

  /** Most recent calendar date for `weekday` strictly before `before`. */
  static defaultSourceDate(before: Date, weekday: number): Date {
    const d = new Date(before);
    d.setUTCHours(0, 0, 0, 0);
    const diff = (d.getUTCDay() - weekday + 7) % 7;
    d.setUTCDate(d.getUTCDate() - (diff === 0 ? 7 : diff));
    return d;
  }

  /** First `weekday` on or after `from` (inclusive). */
  static firstWeekdayOnOrAfter(from: Date, weekday: number): Date {
    const d = new Date(from);
    d.setUTCHours(0, 0, 0, 0);
    const diff = (weekday - d.getUTCDay() + 7) % 7;
    d.setUTCDate(d.getUTCDate() + diff);
    return d;
  }

  private formatDateLabel(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  async getEligibleSlots(query: EligibleSlotsQueryDto, user: IJwtStaffPayload) {
    const makeupDate = this.parseDate(query.makeup_date);

    const group = await this.prisma.teaching_groups.findUnique({
      where: { id: query.teaching_group_id },
    });
    if (!group) throw new NotFoundException('Teaching group not found');
    this.assertCampusAccess(user, group.campus_id);
    assertClassInScope(user, group.class_id);

    const academicYear = this.deriveAcademicYear(makeupDate);
    const timetable = await this.prisma.timetables.findFirst({
      where: {
        campus_id: group.campus_id,
        teaching_group_id: group.id,
        is_active: true,
        academic_year: academicYear,
      },
      orderBy: { effective_from: 'desc' },
    });
    if (!timetable) return { slots: [], timetable_effective_from: null as string | null };

    const slots = await this.prisma.timetable_slots.findMany({
      where: {
        timetable_id: timetable.id,
      },
      include: {
        subjects: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ day_of_week: 'asc' }, { block_number: 'asc' }],
    });

    const periods = await this.classPeriods.list(group.campus_id, group.class_id);
    const periodByBlock = new Map(periods.map((p) => [p.block_number, p]));
    const scheduleStart = new Date(
      Math.max(
        this.academicYearStartDate(group.academic_year).getTime(),
        timetable.effective_from.getTime(),
      ),
    );

    return {
      timetable_effective_from: timetable.effective_from.toISOString().slice(0, 10),
      slots: slots.map((slot) => {
        const period = periodByBlock.get(slot.block_number);
        let defaultSource = ClassSessionReschedulesService.defaultSourceDate(
          makeupDate,
          slot.day_of_week,
        );
        if (defaultSource.getTime() < scheduleStart.getTime()) {
          defaultSource = ClassSessionReschedulesService.firstWeekdayOnOrAfter(
            scheduleStart,
            slot.day_of_week,
          );
        }
        if (defaultSource.getTime() >= makeupDate.getTime()) {
          defaultSource = ClassSessionReschedulesService.defaultSourceDate(
            makeupDate,
            slot.day_of_week,
          );
        }
        return {
          id: slot.id,
          day_of_week: slot.day_of_week,
          day_label: WEEKDAY_NAMES[slot.day_of_week],
          block_number: slot.block_number,
          subject: slot.subjects,
          default_source_date: defaultSource.toISOString().slice(0, 10),
          time_label: period?.label ?? `Period ${slot.block_number}`,
          start_time: period?.start_time ?? null,
          end_time: period?.end_time ?? null,
        };
      }),
    };
  }

  async getSourceDateHoldStatus(
    query: SourceDateHoldStatusQueryDto,
    user: IJwtStaffPayload,
  ) {
    const slotIds = [...new Set(
      query.source_timetable_slot_ids
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    )];
    const dateStrings = query.dates
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (slotIds.length === 0 || dateStrings.length === 0) {
      return { dates: [] as SourceDateHoldStatusRow[] };
    }

    const group = await this.prisma.teaching_groups.findUnique({
      where: { id: query.teaching_group_id },
    });
    if (!group) throw new NotFoundException('Teaching group not found');
    this.assertCampusAccess(user, group.campus_id);
    assertClassInScope(user, group.class_id);

    const slots = await this.prisma.timetable_slots.findMany({
      where: { id: { in: slotIds } },
      select: {
        id: true,
        block_number: true,
        timetables: {
          select: {
            teaching_group_id: true,
            section_id: true,
            effective_from: true,
          },
        },
      },
    });
    const validSlots = slots.filter(
      (slot) => slot.timetables.teaching_group_id === query.teaching_group_id,
    );
    if (validSlots.length === 0) {
      return { dates: [] as SourceDateHoldStatusRow[] };
    }

    const validSlotIds = validSlots.map((s) => s.id);

    const sectionId = validSlots[0]?.timetables.section_id ?? null;
    const timetableStarts = validSlots.map((s) => s.timetables.effective_from.getTime());
    const scheduleStart = new Date(
      Math.max(
        this.academicYearStartDate(group.academic_year).getTime(),
        Math.min(...timetableStarts),
      ),
    );

    const parsedDates = dateStrings.map((d) => this.parseDate(d));
    const minDate = new Date(Math.min(...parsedDates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...parsedDates.map((d) => d.getTime())));

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const blockNumbers = [...new Set(validSlots.map((s) => s.block_number))];
    const sessions = await this.prisma.attendance_roll_sessions.findMany({
      where: {
        teaching_group_id: query.teaching_group_id,
        session_date: { gte: minDate, lte: maxDate },
        OR: [
          { timetable_slot_id: { in: validSlotIds } },
          { timetable_slot_id: null, period: { in: blockNumbers } },
        ],
      },
      select: {
        id: true,
        session_date: true,
        status: true,
        timetable_slot_id: true,
        period: true,
        session_kind: true,
      },
    });

    const findSubmittedSession = (
      iso: string,
      slotId: number,
      blockNumber: number,
    ) => {
      const onDate = sessions.filter(
        (session) =>
          session.session_date.toISOString().slice(0, 10) === iso &&
          session.status === 'SUBMITTED' &&
          session.session_kind !== RollSessionKind.MAKEUP,
      );
      return (
        onDate.find((session) => session.timetable_slot_id === slotId) ??
        onDate.find(
          (session) =>
            session.timetable_slot_id == null && session.period === blockNumber,
        )
      );
    };

    const slotById = new Map(validSlots.map((s) => [s.id, s]));

    this.calendarResolver.beginBatch();
    try {
      const heldMeta: Array<{
        dateIso: string;
        slot_id: number;
        period: number;
        session_id: number;
      }> = [];

      const dates: SourceDateHoldStatusRow[] = await Promise.all<SourceDateHoldStatusRow>(
        dateStrings.map(async (dateStr): Promise<SourceDateHoldStatusRow> => {
          const date = this.parseDate(dateStr);
          const iso = date.toISOString().slice(0, 10);

          if (date.getTime() > today.getTime()) {
            return { date: iso, hold_status: 'upcoming' as const, held: false };
          }

          if (date.getTime() < scheduleStart.getTime()) {
            return { date: iso, hold_status: 'off_day' as const, held: false };
          }

          const dayResolved = await this.calendarResolver.resolveStudentDay(
            group.campus_id,
            group.class_id,
            sectionId,
            date,
          );
          if (!this.isRollCallWorkingDay(dayResolved, date)) {
            return { date: iso, hold_status: 'off_day' as const, held: false };
          }

          const slotStatuses = validSlotIds.map((slotId) => {
            const slot = slotById.get(slotId);
            if (!slot) return 'missed' as const;

            const matching = sessions.filter((session) => {
              if (session.session_date.toISOString().slice(0, 10) !== iso) return false;
              if (session.timetable_slot_id === slotId) return true;
              return session.timetable_slot_id == null && session.period === slot.block_number;
            });

            if (findSubmittedSession(iso, slotId, slot.block_number)) {
              return 'held' as const;
            }
            if (matching.some((s) => s.status === 'SKIPPED')) {
              return 'skipped' as const;
            }
            return 'missed' as const;
          });

          let holdStatus: SourceDateHoldStatus;
          if (slotStatuses.every((s) => s === 'held')) {
            holdStatus = 'held';
          } else if (slotStatuses.every((s) => s === 'skipped')) {
            holdStatus = 'skipped';
          } else {
            holdStatus = 'missed';
          }

          if (holdStatus === 'held') {
            for (const slotId of validSlotIds) {
              const slot = slotById.get(slotId);
              if (!slot) continue;
              const session = findSubmittedSession(iso, slotId, slot.block_number);
              if (session) {
                heldMeta.push({
                  dateIso: iso,
                  slot_id: slotId,
                  period: slot.block_number,
                  session_id: session.id,
                });
              }
            }
          }

          return {
            date: iso,
            hold_status: holdStatus,
            held: holdStatus === 'held',
          };
        }),
      );

      const heldSessionIds = [...new Set(heldMeta.map((m) => m.session_id))];

      if (heldSessionIds.length > 0) {
        const presentRecords = await this.prisma.attendance_roll_records.findMany({
          where: {
            session_id: { in: heldSessionIds },
            status: RollRecordStatus.PRESENT,
          },
          select: {
            session_id: true,
            students: {
              select: { cc: true, full_name: true, gr_number: true },
            },
          },
        });
        presentRecords.sort((a, b) =>
          a.students.full_name.localeCompare(b.students.full_name),
        );

        const presentBySession = new Map<number, SourceDatePresentStudent[]>();
        for (const record of presentRecords) {
          const list = presentBySession.get(record.session_id) ?? [];
          list.push({
            cc: record.students.cc,
            full_name: record.students.full_name,
            gr_number: record.students.gr_number,
          });
          presentBySession.set(record.session_id, list);
        }

        const presentByDate = new Map<string, Map<number, SourceDatePresentBySlot>>();
        for (const meta of heldMeta) {
          const bySlot = presentByDate.get(meta.dateIso) ?? new Map<number, SourceDatePresentBySlot>();
          if (!bySlot.has(meta.slot_id)) {
            bySlot.set(meta.slot_id, {
              slot_id: meta.slot_id,
              period: meta.period,
              students: presentBySession.get(meta.session_id) ?? [],
            });
          }
          presentByDate.set(meta.dateIso, bySlot);
        }

        for (const row of dates) {
          const bySlot = presentByDate.get(row.date);
          if (bySlot) row.present_by_slot = [...bySlot.values()];
        }
      }

      return { dates };
    } finally {
      this.calendarResolver.endBatch();
    }
  }

  private deriveAcademicYear(date: Date): string {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth(); // 0-indexed; Aug = 7
    const startYear = month >= 7 ? year : year - 1;
    return `${startYear}-${startYear + 1}`;
  }

  async findAll(query: ListClassReschedulesQueryDto, user: IJwtStaffPayload) {
    const campusId = query.campus_id ?? user.campusId ?? undefined;
    const where: Record<string, unknown> = {};

    if (query.teaching_group_id) {
      where.teaching_group_id = query.teaching_group_id;
    }
    if (query.status) {
      where.status = query.status as ClassSessionRescheduleStatus;
    }
    if (query.from || query.to) {
      where.source_date = {
        ...(query.from ? { gte: this.parseDate(query.from) } : {}),
        ...(query.to ? { lte: this.parseDate(query.to) } : {}),
      };
    }
    if (campusId) {
      where.teaching_groups = { campus_id: campusId };
    }

    const rows = await this.prisma.class_session_reschedules.findMany({
      where,
      include: {
        teaching_groups: {
          select: {
            id: true,
            label: true,
            class_id: true,
            campus_id: true,
            subjects: { select: { id: true, name: true, code: true } },
            employee_profiles: { select: { id: true, full_name: true } },
          },
        },
        source_timetable_slot: {
          select: { id: true, day_of_week: true, block_number: true },
        },
        makeup_roll_session: { select: { id: true, status: true, session_date: true } },
        source_roll_session: { select: { id: true, status: true, session_date: true } },
        users: { select: { id: true, full_name: true } },
      },
      orderBy: [{ makeup_date: 'desc' }, { id: 'desc' }],
    });

    return rows.map((r) => ({
      ...r,
      source_day_label: WEEKDAY_NAMES[r.source_timetable_slot.day_of_week],
    }));
  }

  async create(dto: CreateClassRescheduleDto, user: IJwtStaffPayload) {
    this.assertCampusAccess(user, dto.campus_id);
    assertClassInScope(user, dto.class_id);

    const sources =
      dto.sources?.length
        ? dto.sources
        : dto.source_timetable_slot_id && dto.source_date
          ? [
              {
                source_timetable_slot_id: dto.source_timetable_slot_id,
                source_date: dto.source_date,
              },
            ]
          : [];

    if (sources.length === 0) {
      throw new BadRequestException('At least one source slot is required');
    }

    const makeupDate = this.parseDate(dto.makeup_date);

    const group = await this.prisma.teaching_groups.findUnique({
      where: { id: dto.teaching_group_id },
    });
    if (!group) throw new NotFoundException('Teaching group not found');
    if (group.campus_id !== dto.campus_id || group.class_id !== dto.class_id) {
      throw new BadRequestException('Teaching group does not match campus/class');
    }

    if (dto.makeup_timetable_slot_id) {
      const makeupSlot = await this.prisma.timetable_slots.findUnique({
        where: { id: dto.makeup_timetable_slot_id },
        include: { timetables: true },
      });
      if (!makeupSlot) throw new NotFoundException('Makeup timetable slot not found');
      if (makeupSlot.timetables.teaching_group_id !== dto.teaching_group_id) {
        throw new BadRequestException('Makeup slot does not belong to this teaching group');
      }
    }

    const validatedSources: Array<{
      source_timetable_slot_id: number;
      source_date: Date;
    }> = [];

    for (const item of sources) {
      const sourceDate = this.parseDate(item.source_date);
      const sourceSlot = await this.prisma.timetable_slots.findUnique({
        where: { id: item.source_timetable_slot_id },
        include: { timetables: true },
      });
      if (!sourceSlot) {
        throw new NotFoundException(`Source timetable slot ${item.source_timetable_slot_id} not found`);
      }
      if (sourceSlot.timetables.teaching_group_id !== dto.teaching_group_id) {
        throw new BadRequestException(
          `Source slot ${item.source_timetable_slot_id} does not belong to this teaching group`,
        );
      }
      if (sourceSlot.day_of_week !== sourceDate.getUTCDay()) {
        throw new BadRequestException(
          `Source date ${item.source_date} does not match slot weekday for slot ${item.source_timetable_slot_id}`,
        );
      }

      const timetableStart = sourceSlot.timetables.effective_from;
      const scheduleStart = new Date(
        Math.max(
          this.academicYearStartDate(group.academic_year).getTime(),
          timetableStart.getTime(),
        ),
      );
      if (sourceDate.getTime() < scheduleStart.getTime()) {
        throw new BadRequestException(
          `Source date ${item.source_date} is before this timetable started (${this.formatDateLabel(scheduleStart)})`,
        );
      }

      validatedSources.push({
        source_timetable_slot_id: item.source_timetable_slot_id,
        source_date: sourceDate,
      });
    }

    const existingBundle = await this.prisma.class_session_reschedules.findFirst({
      where: {
        teaching_group_id: dto.teaching_group_id,
        makeup_date: makeupDate,
        status: 'PENDING',
        makeup_roll_session_id: { not: null },
      },
      orderBy: { id: 'asc' },
    });

    let makeupSession: { id: number };
    if (existingBundle?.makeup_roll_session_id) {
      makeupSession = { id: existingBundle.makeup_roll_session_id };
    } else {
      makeupSession = await this.rollSessions.createMakeupSession(
        {
          campus_id: dto.campus_id,
          class_id: dto.class_id,
          teaching_group_id: dto.teaching_group_id,
          session_date: dto.makeup_date,
          period: dto.makeup_period,
          timetable_slot_id: dto.makeup_timetable_slot_id,
        },
        user,
      );
    }

    const createdRows: Array<{ id: number }> = [];
    for (const item of validatedSources) {
      const existing = await this.prisma.class_session_reschedules.findFirst({
        where: {
          teaching_group_id: dto.teaching_group_id,
          source_date: item.source_date,
          source_timetable_slot_id: item.source_timetable_slot_id,
        },
      });

      if (existing?.status === 'COMPLETED') {
        throw new BadRequestException(
          `A completed reschedule already exists for slot ${item.source_timetable_slot_id} on ${this.formatDateLabel(item.source_date)}`,
        );
      }

      if (existing?.status === 'PENDING') {
        if (existing.makeup_roll_session_id === makeupSession.id) {
          createdRows.push(existing);
          continue;
        }
        createdRows.push(
          await this.reattachPendingSourceRow(existing, makeupSession.id, {
            makeup_date: makeupDate,
            makeup_period: dto.makeup_period,
            makeup_timetable_slot_id: dto.makeup_timetable_slot_id,
          }),
        );
        continue;
      }

      if (existing?.status === 'CANCELLED') {
        await this.prisma.class_session_reschedules.delete({ where: { id: existing.id } });
      }

      try {
        const row = await this.prisma.class_session_reschedules.create({
          data: {
            teaching_group_id: dto.teaching_group_id,
            source_timetable_slot_id: item.source_timetable_slot_id,
            source_date: item.source_date,
            makeup_date: makeupDate,
            makeup_period: dto.makeup_period,
            makeup_timetable_slot_id: dto.makeup_timetable_slot_id ?? null,
            makeup_roll_session_id: makeupSession.id,
            created_by_id: user.sub,
            notes: dto.notes,
          },
        });
        createdRows.push(row);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== 'P2002') throw err;
        const raced = await this.prisma.class_session_reschedules.findFirst({
          where: {
            teaching_group_id: dto.teaching_group_id,
            source_date: item.source_date,
            source_timetable_slot_id: item.source_timetable_slot_id,
          },
        });
        if (raced?.status === 'PENDING') {
          if (raced.makeup_roll_session_id === makeupSession.id) {
            createdRows.push(raced);
            continue;
          }
          createdRows.push(
            await this.reattachPendingSourceRow(raced, makeupSession.id, {
              makeup_date: makeupDate,
              makeup_period: dto.makeup_period,
              makeup_timetable_slot_id: dto.makeup_timetable_slot_id,
            }),
          );
          continue;
        }
        throw new BadRequestException(
          `A reschedule already exists for slot ${item.source_timetable_slot_id} on ${this.formatDateLabel(item.source_date)}`,
        );
      }
    }

    const bundleReschedules = await this.prisma.class_session_reschedules.findMany({
      where: { makeup_roll_session_id: makeupSession.id, status: 'PENDING' },
      select: { id: true },
    });

    if (bundleReschedules.length > 0) {
      await this.prisma.attendance_roll_sessions.update({
        where: { id: makeupSession.id },
        data: { reschedule_id: bundleReschedules[0].id },
      });
    }

    const resultIds =
      createdRows.length > 0 ? createdRows : bundleReschedules;

    return {
      reschedules: await Promise.all(resultIds.map((r) => this.findOne(r.id, user))),
      makeup_session: await this.rollSessions.findOne(makeupSession.id, user),
    };
  }

  async findOne(id: number, user: IJwtStaffPayload) {
    const row = await this.prisma.class_session_reschedules.findUnique({
      where: { id },
      include: {
        teaching_groups: {
          select: {
            id: true,
            label: true,
            class_id: true,
            campus_id: true,
            subjects: { select: { id: true, name: true, code: true } },
            employee_profiles: { select: { id: true, full_name: true } },
          },
        },
        source_timetable_slot: {
          select: { id: true, day_of_week: true, block_number: true },
        },
        makeup_roll_session: { select: { id: true, status: true, session_date: true, period: true } },
        source_roll_session: { select: { id: true, status: true, session_date: true, period: true } },
        users: { select: { id: true, full_name: true } },
      },
    });
    if (!row) throw new NotFoundException('Reschedule not found');
    this.assertCampusAccess(user, row.teaching_groups.campus_id);
    assertClassInScope(user, row.teaching_groups.class_id);
    return {
      ...row,
      source_day_label: WEEKDAY_NAMES[row.source_timetable_slot.day_of_week],
    };
  }

  async cancel(id: number, user: IJwtStaffPayload) {
    const row = await this.findOne(id, user);
    if (row.status !== 'PENDING') {
      throw new BadRequestException('Only pending reschedules can be cancelled');
    }

    await this.prisma.$transaction(async (tx) => {
      const makeupSessionId = row.makeup_roll_session_id;
      await tx.class_session_reschedules.update({
        where: { id },
        data: { status: 'CANCELLED', makeup_roll_session_id: null },
      });

      if (makeupSessionId) {
        const remaining = await tx.class_session_reschedules.count({
          where: { makeup_roll_session_id: makeupSessionId, status: 'PENDING' },
        });
        if (remaining === 0) {
          const session = await tx.attendance_roll_sessions.findUnique({
            where: { id: makeupSessionId },
          });
          if (session && session.status === 'DRAFT') {
            await tx.attendance_roll_records.deleteMany({
              where: { session_id: session.id },
            });
            await tx.attendance_roll_sessions.delete({ where: { id: session.id } });
          }
        }
      }
    });

    return this.findOne(id, user);
  }

  async updateMakeupDate(id: number, makeupDateStr: string, user: IJwtStaffPayload) {
    const row = await this.findOne(id, user);
    if (row.status !== 'PENDING') {
      throw new BadRequestException('Only pending reschedules can be updated');
    }

    const makeupDate = this.parseDate(makeupDateStr);
    const previousSessionId = row.makeup_roll_session_id;

    const existingBundle = await this.prisma.class_session_reschedules.findFirst({
      where: {
        teaching_group_id: row.teaching_group_id,
        makeup_date: makeupDate,
        status: 'PENDING',
        makeup_roll_session_id: { not: null },
        id: { not: id },
      },
      orderBy: { id: 'asc' },
    });

    let makeupSessionId: number;
    if (existingBundle?.makeup_roll_session_id) {
      makeupSessionId = existingBundle.makeup_roll_session_id;
    } else {
      const session = await this.rollSessions.createMakeupSession(
        {
          campus_id: row.teaching_groups.campus_id,
          class_id: row.teaching_groups.class_id,
          teaching_group_id: row.teaching_group_id,
          session_date: makeupDateStr,
          period: row.makeup_period,
          timetable_slot_id: row.makeup_timetable_slot_id ?? undefined,
        },
        user,
      );
      makeupSessionId = session.id;
    }

    await this.prisma.class_session_reschedules.update({
      where: { id },
      data: {
        makeup_date: makeupDate,
        makeup_roll_session_id: makeupSessionId,
      },
    });

    const bundleReschedules = await this.prisma.class_session_reschedules.findMany({
      where: { makeup_roll_session_id: makeupSessionId, status: 'PENDING' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (bundleReschedules.length > 0) {
      await this.prisma.attendance_roll_sessions.update({
        where: { id: makeupSessionId },
        data: { reschedule_id: bundleReschedules[0].id },
      });
    }

    if (previousSessionId && previousSessionId !== makeupSessionId) {
      await this.cleanupOrphanMakeupSession(previousSessionId);
      const remainingOnOld = await this.prisma.class_session_reschedules.findMany({
        where: { makeup_roll_session_id: previousSessionId, status: 'PENDING' },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      if (remainingOnOld.length > 0) {
        await this.prisma.attendance_roll_sessions.update({
          where: { id: previousSessionId },
          data: { reschedule_id: remainingOnOld[0].id },
        });
      }
    }

    return this.findOne(id, user);
  }

  async reverse(id: number, user: IJwtStaffPayload) {
    const row = await this.findOne(id, user);
    if (row.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed reschedules can be reversed');
    }

    const makeupNote = `Makeup held ${this.formatDateLabel(row.makeup_date)}`;

    await this.prisma.$transaction(async (tx) => {
      if (row.source_roll_session_id) {
        const excusedRecords = await tx.attendance_roll_records.findMany({
          where: {
            session_id: row.source_roll_session_id,
            status: RollRecordStatus.EXCUSED,
            notes: { contains: makeupNote },
          },
        });
        for (const rec of excusedRecords) {
          await tx.attendance_roll_records.update({
            where: { id: rec.id },
            data: { status: RollRecordStatus.ABSENT, notes: null },
          });
        }
      }

      const employeeId = row.teaching_groups.employee_profiles?.id;
      if (employeeId) {
        const staffRow = await tx.attendance_staff_daily.findUnique({
          where: {
            employee_id_date: { employee_id: employeeId, date: row.source_date },
          },
        });
        if (
          staffRow?.status === StaffAttendanceStatus.EXCUSED &&
          staffRow.source === AttendanceSource.SYSTEM &&
          staffRow.notes?.includes('Makeup class held')
        ) {
          await tx.attendance_staff_daily.delete({
            where: { id: staffRow.id },
          });
        }
      }

      await tx.class_session_reschedules.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          source_roll_session_id: null,
        },
      });
    });

    void this.auditLogs.log({
      entity_type: 'CLASS_RESCHEDULE',
      entity_id: String(id),
      action: 'UPDATED',
      field: 'status',
      old_value: 'COMPLETED',
      new_value: 'CANCELLED',
      changed_by: auditActorLabel(user),
      note: `Reschedule #${id} reversed.`,
    });

    return this.findOne(id, user);
  }

  /** Called when a MAKEUP roll session is submitted. */
  async completeOnMakeupSubmit(
    makeupSessionId: number,
    user: IJwtStaffPayload,
  ): Promise<RescheduleCompletionResult> {
    const makeupSession = await this.prisma.attendance_roll_sessions.findUnique({
      where: { id: makeupSessionId },
      include: { attendance_roll_records: true },
    });
    if (!makeupSession || makeupSession.session_kind !== RollSessionKind.MAKEUP) {
      return {
        sourceCount: 0,
        excusedStudentCount: 0,
        absentStudentCount: 0,
        staffExcusedDays: 0,
        staffExcuseWarnings: [],
      };
    }

    const reschedules = await this.prisma.class_session_reschedules.findMany({
      where: { makeup_roll_session_id: makeupSessionId, status: 'PENDING' },
      include: {
        source_timetable_slot: true,
        teaching_groups: true,
      },
    });

    if (reschedules.length === 0) {
      return {
        sourceCount: 0,
        excusedStudentCount: 0,
        absentStudentCount: 0,
        staffExcusedDays: 0,
        staffExcuseWarnings: [],
      };
    }

    const roster = await this.prisma.student_subject_enrollments.findMany({
      where: {
        teaching_group_id: reschedules[0].teaching_group_id,
        students: { status: ENROLLED, deleted_at: null },
      },
      select: { student_id: true },
    });
    const rosterCcs = new Set(roster.map((r) => r.student_id));
    const makeupByCc = new Map(
      makeupSession.attendance_roll_records.map((r) => [r.student_cc, r]),
    );

    let excusedStudentCount = 0;
    let absentStudentCount = 0;
    let staffExcusedDays = 0;
    const staffExcuseWarnings: string[] = [];
    const employeeId =
      makeupSession.snapshot_employee_id ?? reschedules[0].teaching_groups.employee_id;

    for (const reschedule of reschedules) {
      const makeupNote = `Makeup held ${this.formatDateLabel(reschedule.makeup_date)}`;
      const sourceSession = await this.ensureSourceRollSession(
        reschedule,
        makeupSession,
        user,
      );

      for (const cc of rosterCcs) {
        const makeupRecord = makeupByCc.get(cc);
        const sourceStatus =
          makeupRecord?.status === RollRecordStatus.PRESENT
            ? RollRecordStatus.EXCUSED
            : RollRecordStatus.ABSENT;
        const notes =
          sourceStatus === RollRecordStatus.EXCUSED ? makeupNote : undefined;

        await this.prisma.attendance_roll_records.upsert({
          where: {
            session_id_student_cc: {
              session_id: sourceSession.id,
              student_cc: cc,
            },
          },
          create: {
            session_id: sourceSession.id,
            student_cc: cc,
            status: sourceStatus,
            notes,
          },
          update: { status: sourceStatus, notes: notes ?? null },
        });

        if (sourceStatus === RollRecordStatus.EXCUSED) excusedStudentCount++;
        else absentStudentCount++;
      }

      await this.prisma.attendance_roll_sessions.update({
        where: { id: sourceSession.id },
        data: {
          status: 'SUBMITTED',
          submitted_by_id: user.sub,
          submitted_at: new Date(),
        },
      });

      const { staffExcused, staffExcuseWarning } = await this.tryExcuseTeacher(
        reschedule,
        employeeId,
        reschedules[0].teaching_groups.campus_id,
      );
      if (staffExcused) staffExcusedDays++;
      if (staffExcuseWarning) staffExcuseWarnings.push(staffExcuseWarning);

      await this.prisma.class_session_reschedules.update({
        where: { id: reschedule.id },
        data: {
          status: 'COMPLETED',
          source_roll_session_id: sourceSession.id,
        },
      });

      void this.auditLogs.log({
        entity_type: 'CLASS_RESCHEDULE',
        entity_id: String(reschedule.id),
        action: 'UPDATED',
        field: 'status',
        old_value: 'PENDING',
        new_value: 'COMPLETED',
        changed_by: auditActorLabel(user),
        note: `Reschedule #${reschedule.id} completed via makeup session #${makeupSessionId}.`,
      });
    }

    return {
      sourceCount: reschedules.length,
      excusedStudentCount,
      absentStudentCount,
      staffExcusedDays,
      staffExcuseWarnings,
    };
  }

  private async ensureSourceRollSession(
    reschedule: {
      id: number;
      source_date: Date;
      source_timetable_slot_id: number;
      teaching_group_id: number;
      source_timetable_slot: { block_number: number; subject_id: number; employee_id: number };
      teaching_groups: { campus_id: number; class_id: number; subject_id: number; employee_id: number };
    },
    makeupSession: {
      campus_id: number;
      class_id: number;
      section_id: number | null;
      snapshot_subject_id: number | null;
      snapshot_employee_id: number | null;
    },
    user: IJwtStaffPayload,
  ) {
    const sourceSlot = reschedule.source_timetable_slot;
    const existing = await this.prisma.attendance_roll_sessions.findFirst({
      where: {
        campus_id: makeupSession.campus_id,
        class_id: makeupSession.class_id,
        section_id: makeupSession.section_id,
        teaching_group_id: reschedule.teaching_group_id,
        session_date: reschedule.source_date,
        period: sourceSlot.block_number,
        timetable_slot_id: reschedule.source_timetable_slot_id,
      },
    });

    if (existing) {
      if (existing.status === 'SKIPPED') {
        await this.prisma.attendance_roll_sessions.update({
          where: { id: existing.id },
          data: { status: 'DRAFT', skip_reason: null },
        });
      }
      return existing;
    }

    return this.prisma.attendance_roll_sessions.create({
      data: {
        campus_id: makeupSession.campus_id,
        class_id: makeupSession.class_id,
        section_id: makeupSession.section_id,
        teaching_group_id: reschedule.teaching_group_id,
        session_date: reschedule.source_date,
        period: sourceSlot.block_number,
        timetable_slot_id: reschedule.source_timetable_slot_id,
        snapshot_subject_id:
          makeupSession.snapshot_subject_id ?? reschedule.teaching_groups.subject_id,
        snapshot_employee_id:
          makeupSession.snapshot_employee_id ?? reschedule.teaching_groups.employee_id,
        session_kind: RollSessionKind.REGULAR,
        created_by_id: user.sub,
        status: 'DRAFT',
      },
    });
  }

  private async tryExcuseTeacher(
    reschedule: { source_date: Date; makeup_date: Date; source_timetable_slot_id: number },
    employeeId: number,
    campusId?: number,
  ): Promise<{ staffExcused: boolean; staffExcuseWarning: string | null }> {
    let resolvedCampus = campusId;
    if (!resolvedCampus) {
      const group = await this.prisma.teaching_groups.findFirst({
        where: { employee_id: employeeId },
        select: { campus_id: true },
      });
      resolvedCampus = group?.campus_id;
    }
    return this.staffLessonExcuse.excuseTeacherForMissedLesson({
      employeeId,
      sourceDate: reschedule.source_date,
      makeupDate: reschedule.makeup_date,
      sourceSlotId: reschedule.source_timetable_slot_id,
      campusId: resolvedCampus,
    });
  }

  /** True when a pending reschedule covers this draft source session — skip auto-skip. */
  async hasPendingRescheduleForSession(session: {
    teaching_group_id: number | null;
    session_date: Date;
    timetable_slot_id: number | null;
  }): Promise<boolean> {
    if (!session.teaching_group_id || !session.timetable_slot_id) return false;
    const pending = await this.prisma.class_session_reschedules.findFirst({
      where: {
        teaching_group_id: session.teaching_group_id,
        source_date: session.session_date,
        source_timetable_slot_id: session.timetable_slot_id,
        status: 'PENDING',
      },
    });
    return pending != null;
  }

  async hasPendingRescheduleForSource(
    teachingGroupId: number,
    sourceDate: Date,
    sourceSlotId: number,
  ): Promise<boolean> {
    const pending = await this.prisma.class_session_reschedules.findFirst({
      where: {
        teaching_group_id: teachingGroupId,
        source_date: sourceDate,
        source_timetable_slot_id: sourceSlotId,
        status: 'PENDING',
      },
    });
    return pending != null;
  }
}
