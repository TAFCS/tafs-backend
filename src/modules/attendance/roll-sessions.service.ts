import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RollSessionKind, RollSessionStatus, student_status } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { assertClassInScope } from '../../common/staff-scope';
import {
  CreateRollSessionDto,
  ListRollSessionsQueryDto,
  SkipRollSessionDto,
  UpdateRollSessionDto,
} from './dto/roll-sessions.dto';
import { RollCallAnnouncementsService } from './roll-call-announcements.service';
import {
  CalendarDayResolverService,
  ResolvedCalendarDay,
} from '../hr/calendar/calendar-day-resolver.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { ClassSessionReschedulesService } from './class-session-reschedules.service';

/** Fallback IDs used only when no class_attendance_modes rows exist yet. */
const DEFAULT_ROLL_CALL_CLASS_IDS = [21, 22];
const ENROLLED: student_status = 'ENROLLED';

@Injectable()
export class RollSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly announcements: RollCallAnnouncementsService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly auditLogs: AuditLogsService,
    @Inject(forwardRef(() => ClassSessionReschedulesService))
    private readonly reschedules: ClassSessionReschedulesService,
  ) {}

  private parseDate(dateStr: string): Date {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private assertCampusAccess(user: IJwtStaffPayload, campusId: number) {
    if (user.campusId && user.campusId !== campusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }
  }

  private async assertRollCallClass(classId: number) {
    const mode = await this.prisma.class_attendance_modes.findUnique({
      where: { class_id: classId },
    });
    // Fall back to default IDs only if the modes table has no entry for this class
    const isRollCall =
      mode?.mode === 'ROLL_CALL_SESSION' ||
      (!mode && DEFAULT_ROLL_CALL_CLASS_IDS.includes(classId));
    if (!isRollCall) {
      throw new BadRequestException(
        'This class uses biometric daily attendance, not roll call sessions',
      );
    }
  }

  /** Returns all class IDs configured for roll call mode. Reads from DB — not hardcoded. */
  private async getRollCallClassIds(): Promise<number[]> {
    const modes = await this.prisma.class_attendance_modes.findMany({
      where: { mode: 'ROLL_CALL_SESSION' },
      select: { class_id: true },
    });
    if (modes.length > 0) return modes.map((m) => m.class_id);
    // Graceful fallback if the table is empty (fresh deploy before seed)
    return DEFAULT_ROLL_CALL_CLASS_IDS;
  }

  /**
   * Roll-call classes (A-Level AS/A2) hold Saturday lessons, but the generic
   * Mon–Fri weekend default has no idea of that and reports Saturday as a day
   * off. Treat that *default* Saturday weekend as a working day for roll call.
   * Sunday stays off, and an explicit calendar HOLIDAY/WEEKEND row for the
   * date (source 'CALENDAR' — a real declared day off) still wins.
   */
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

  private async assertCampusSection(
    campusId: number,
    classId: number,
    sectionId: number,
  ) {
    const link = await this.prisma.campus_sections.findFirst({
      where: { campus_id: campusId, class_id: classId, section_id: sectionId },
    });
    if (!link) {
      throw new BadRequestException('Section is not offered for this class at this campus');
    }
  }

  private sessionInclude() {
    return {
      classes:   { select: { id: true, description: true, class_code: true, academic_system: true } },
      sections:  { select: { id: true, description: true } },
      campuses:  { select: { id: true, campus_name: true, campus_code: true } },
      teaching_groups: {
        select: {
          id: true,
          label: true,
          subjects: { select: { id: true, name: true, code: true } },
          employee_profiles: { select: { id: true, full_name: true } },
        },
      },
      // Subject/teacher as they stood at the moment this session was created —
      // frozen so a later timetable edit or teaching-group reassignment can't
      // silently relabel history. Null on rows created before this snapshot
      // existed; withResolvedSubjectTeacher() falls back to the live
      // teaching_groups join for those.
      subjects:          { select: { id: true, name: true, code: true } },
      employee_profiles: { select: { id: true, full_name: true } },
      class_session_reschedules: {
        select: {
          id: true,
          status: true,
          source_date: true,
          makeup_date: true,
          source_timetable_slot: { select: { day_of_week: true, block_number: true } },
        },
      },
      reschedule_as_source: {
        select: {
          id: true,
          status: true,
          source_date: true,
          makeup_date: true,
        },
      },
      users_attendance_roll_sessions_created_by_idTousers:   { select: { id: true, full_name: true } },
      users_attendance_roll_sessions_submitted_by_idTousers: { select: { id: true, full_name: true } },
      attendance_roll_records: {
        include: {
          students: {
            select: {
              cc: true,
              full_name: true,
              gr_number: true,
              class_id: true,
              section_id: true,
            },
          },
        },
        orderBy: { id: 'asc' as const },
      },
    } satisfies Prisma.attendance_roll_sessionsInclude;
  }

  async findAll(query: ListRollSessionsQueryDto, user: IJwtStaffPayload) {
    const sessionDate = this.parseDate(query.date);
    const campusId = query.campus_id ?? user.campusId ?? undefined;
    if (!campusId) {
      throw new BadRequestException('campus_id is required');
    }
    this.assertCampusAccess(user, campusId);
    if (query.class_id) {
      assertClassInScope(user, query.class_id);
    }

    const allowed = user.allowedClassIds ?? [];
    const where: Prisma.attendance_roll_sessionsWhereInput = {
      session_date: sessionDate,
      campus_id: campusId,
      ...(query.class_id
        ? { class_id: query.class_id }
        : allowed.length > 0
          ? { class_id: { in: allowed } }
          : {}),
      ...(query.section_id ? { section_id: query.section_id } : {}),
      ...(query.period ? { period: query.period } : {}),
      ...(query.timetable_slot_id !== undefined
        ? { timetable_slot_id: query.timetable_slot_id }
        : {}),
      ...(query.teaching_group_id !== undefined
        ? { teaching_group_id: query.teaching_group_id }
        : {}),
    };

    const sessions = await this.prisma.attendance_roll_sessions.findMany({
      where,
      include: this.sessionInclude(),
      orderBy: [{ class_id: 'asc' }, { section_id: 'asc' }, { period: 'asc' }],
    });
    return sessions.map((s) => this.withResolvedSubjectTeacher(s));
  }

  async findOne(id: number, user: IJwtStaffPayload) {
    const session = await this.prisma.attendance_roll_sessions.findUnique({
      where: { id },
      include: this.sessionInclude(),
    });
    if (!session) {
      throw new NotFoundException(`Roll session ${id} not found`);
    }
    this.assertCampusAccess(user, session.campus_id);
    assertClassInScope(user, session.class_id);
    const reopened = await this.reopenSkippedMakeupSession(session);
    return this.enrichWithRoster(reopened);
  }

  /** Reopens auto-skipped makeup sessions so attendance can be taken. */
  private async reopenSkippedMakeupSession(
    session: Prisma.attendance_roll_sessionsGetPayload<{
      include: ReturnType<RollSessionsService['sessionInclude']>;
    }>,
    opts?: { sessionKind?: RollSessionKind; rescheduleId?: number },
  ) {
    if (session.status !== 'SKIPPED') {
      return session;
    }

    const isMakeup =
      session.session_kind === RollSessionKind.MAKEUP ||
      opts?.sessionKind === RollSessionKind.MAKEUP ||
      (await this.prisma.class_session_reschedules.findFirst({
        where: {
          makeup_roll_session_id: session.id,
          status: { in: ['SCHEDULED', 'COMPLETED'] },
        },
        select: { id: true },
      })) != null;

    if (!isMakeup) {
      return session;
    }

    return this.prisma.attendance_roll_sessions.update({
      where: { id: session.id },
      data: {
        status: 'DRAFT',
        skip_reason: null,
        session_kind: RollSessionKind.MAKEUP,
        reschedule_id: opts?.rescheduleId ?? session.reschedule_id,
        submitted_by_id: null,
        submitted_at: null,
      },
      include: this.sessionInclude(),
    });
  }

  private async getRosterStudents(
    campusId: number,
    classId: number,
    sectionId: number | null,
    teachingGroupId: number | null,
  ) {
    if (teachingGroupId) {
      const enrollments = await this.prisma.student_subject_enrollments.findMany({
        where: {
          teaching_group_id: teachingGroupId,
          students: { status: ENROLLED, deleted_at: null },
        },
        select: {
          students: {
            select: {
              cc: true,
              full_name: true,
              gr_number: true,
              class_id: true,
              section_id: true,
            },
          },
        },
        orderBy: { students: { full_name: 'asc' } },
      });
      return enrollments.map((e) => e.students);
    }

    return this.prisma.students.findMany({
      where: {
        campus_id: campusId,
        class_id: classId,
        section_id: sectionId,
        status: ENROLLED,
        deleted_at: null,
      },
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        class_id: true,
        section_id: true,
      },
      orderBy: { full_name: 'asc' },
    });
  }

  /**
   * Effective subject/teacher for a session: the snapshot taken at creation
   * time if present, otherwise the live teaching_group join (only true for
   * rows created before the snapshot columns existed).
   */
  private withResolvedSubjectTeacher(session: any) {
    return {
      ...session,
      subject: session.subjects ?? session.teaching_groups?.subjects ?? null,
      teacher: session.employee_profiles ?? session.teaching_groups?.employee_profiles ?? null,
    };
  }

  private async enrichWithRoster(session: any) {
    session = this.withResolvedSubjectTeacher(session);
    const roster = await this.getRosterStudents(
      session.campus_id,
      session.class_id,
      session.section_id,
      session.teaching_group_id,
    );
    const markedByCc = new Map(
      (session.attendance_roll_records ?? []).map((r: any) => [r.student_cc, r]),
    );
    return {
      ...session,
      roster: roster.map((s) => ({
        student: s,
        record: markedByCc.get(s.cc) ?? null,
      })),
    };
  }

  async create(dto: CreateRollSessionDto, user: IJwtStaffPayload) {
    return this.createSession(dto, user, { sessionKind: RollSessionKind.REGULAR });
  }

  /** Opens a MAKEUP roll session linked to a scheduled class reschedule. */
  async createMakeupSession(
    dto: CreateRollSessionDto & { reschedule_id?: number },
    user: IJwtStaffPayload,
  ) {
    return this.createSession(dto, user, {
      sessionKind: RollSessionKind.MAKEUP,
      rescheduleId: dto.reschedule_id,
      skipWeekdayValidation: true,
    });
  }

  private async createSession(
    dto: CreateRollSessionDto,
    user: IJwtStaffPayload,
    opts: {
      sessionKind: RollSessionKind;
      rescheduleId?: number;
      skipWeekdayValidation?: boolean;
    },
  ) {
    this.assertCampusAccess(user, dto.campus_id);
    assertClassInScope(user, dto.class_id);
    await this.assertRollCallClass(dto.class_id);

    if (!dto.section_id && !dto.teaching_group_id) {
      throw new BadRequestException('Either section_id or teaching_group_id is required');
    }
    if (dto.section_id && dto.teaching_group_id) {
      throw new BadRequestException('Provide only one of section_id or teaching_group_id');
    }

    let sectionId: number | null = null;
    let teachingGroupId: number | null = null;
    // Frozen at creation time so a later timetable edit or teaching-group
    // reassignment can't silently relabel this session's history. The slot
    // (if any) is more specific than the group's default assignment, so it
    // wins when both are present.
    let snapshotSubjectId: number | null = null;
    let snapshotEmployeeId: number | null = null;

    if (dto.teaching_group_id) {
      const group = await this.prisma.teaching_groups.findUnique({
        where: { id: dto.teaching_group_id },
      });
      if (!group) throw new NotFoundException('Teaching group not found');
      if (group.campus_id !== dto.campus_id || group.class_id !== dto.class_id) {
        throw new BadRequestException(
          'Teaching group does not belong to this campus/class',
        );
      }
      teachingGroupId = group.id;
      snapshotSubjectId = group.subject_id;
      snapshotEmployeeId = group.employee_id;
    } else {
      await this.assertCampusSection(dto.campus_id, dto.class_id, dto.section_id!);
      sectionId = dto.section_id!;
    }

    const sessionDate = this.parseDate(dto.session_date);
    let period = dto.period ?? 1;
    let timetableSlotId: number | null = dto.timetable_slot_id ?? null;

    if (dto.timetable_slot_id) {
      const slot = await this.prisma.timetable_slots.findUnique({
        where: { id: dto.timetable_slot_id },
        include: { timetables: true },
      });
      if (!slot) {
        throw new NotFoundException('Timetable slot not found');
      }
      const tt = slot.timetables;
      const scopeMatches = teachingGroupId
        ? tt.campus_id === dto.campus_id && tt.teaching_group_id === teachingGroupId
        : tt.campus_id === dto.campus_id &&
          tt.class_id === dto.class_id &&
          tt.section_id === sectionId;
      if (!scopeMatches) {
        throw new BadRequestException(
          'Timetable slot does not match campus/class/section (or teaching group)',
        );
      }
      if (!opts.skipWeekdayValidation && slot.day_of_week !== sessionDate.getUTCDay()) {
        throw new BadRequestException(
          'Timetable slot is not scheduled for this weekday',
        );
      }
      period = slot.block_number;
      timetableSlotId = slot.id;
      snapshotSubjectId = slot.subject_id;
      snapshotEmployeeId = slot.employee_id;
    }

    const dayResolved = await this.calendarResolver.resolveStudentDay(
      dto.campus_id,
      dto.class_id,
      sectionId,
      sessionDate,
    );

    const existing = await this.prisma.attendance_roll_sessions.findFirst({
      where: {
        campus_id: dto.campus_id,
        class_id: dto.class_id,
        section_id: sectionId,
        teaching_group_id: teachingGroupId,
        session_date: sessionDate,
        period,
        timetable_slot_id: timetableSlotId,
      },
      include: this.sessionInclude(),
    });

    if (existing) {
      const reopened = await this.reopenSkippedMakeupSession(existing, opts);
      return this.enrichWithRoster(reopened);
    }

    // Makeup sessions are deliberately placed on specific dates (including
    // one-off days); never auto-skip them based on the calendar.
    if (
      opts.sessionKind !== RollSessionKind.MAKEUP &&
      !this.isRollCallWorkingDay(dayResolved, sessionDate)
    ) {
      const skipReason = `Holiday: ${dayResolved.description ?? dayResolved.dayType ?? 'Day off'}`;
      const session = await this.prisma.attendance_roll_sessions.create({
        data: {
          campus_id: dto.campus_id,
          class_id: dto.class_id,
          section_id: sectionId,
          teaching_group_id: teachingGroupId,
          session_date: sessionDate,
          period,
          timetable_slot_id: timetableSlotId,
          snapshot_subject_id: snapshotSubjectId,
          snapshot_employee_id: snapshotEmployeeId,
          status: 'SKIPPED',
          skip_reason: skipReason,
          created_by_id: user.sub,
          submitted_by_id: user.sub,
          submitted_at: new Date(),
        },
        include: this.sessionInclude(),
      });
      void this.announcements
        .announceSessionSkipped(session.id)
        .catch((e) =>
          console.error(
            `Roll session #${session.id}: announceSessionSkipped failed`,
            e,
          ),
        );
      return this.enrichWithRoster(session);
    }

    const session = await this.prisma.attendance_roll_sessions.create({
      data: {
        campus_id: dto.campus_id,
        class_id: dto.class_id,
        section_id: sectionId,
        teaching_group_id: teachingGroupId,
        session_date: sessionDate,
        period,
        timetable_slot_id: timetableSlotId,
        snapshot_subject_id: snapshotSubjectId,
        snapshot_employee_id: snapshotEmployeeId,
        session_kind: opts.sessionKind,
        reschedule_id: opts.rescheduleId ?? null,
        created_by_id: user.sub,
      },
      include: this.sessionInclude(),
    });

    void this.auditLogs.log({
      entity_type: 'ROLL_SESSION',
      entity_id: String(session.id),
      action: 'CREATED',
      field: 'status',
      new_value: session.status,
      changed_by: auditActorLabel(user),
      note: `Roll session opened campus=${dto.campus_id} class=${dto.class_id} scope=${teachingGroupId ? `teaching_group=${teachingGroupId}` : `section=${sectionId}`} date=${dto.session_date} period=${period}.`,
    });

    return this.enrichWithRoster(session);
  }

  async update(
    id: number,
    dto: UpdateRollSessionDto,
    user: IJwtStaffPayload,
    canEditLocked: boolean,
  ) {
    const session = await this.prisma.attendance_roll_sessions.findUnique({
      where: { id },
      include: { attendance_roll_records: true },
    });
    if (!session) {
      throw new NotFoundException(`Roll session ${id} not found`);
    }
    this.assertCampusAccess(user, session.campus_id);
    assertClassInScope(user, session.class_id);

    if (session.status === 'SUBMITTED' && !canEditLocked) {
      throw new ForbiddenException(
        'This roll session is locked. You need attendance.student.edit_locked permission to edit.',
      );
    }

    const dayResolved = await this.calendarResolver.resolveStudentDay(
      session.campus_id,
      session.class_id,
      session.section_id,
      session.session_date,
    );
    if (
      session.session_kind !== RollSessionKind.MAKEUP &&
      !this.isRollCallWorkingDay(dayResolved, session.session_date) &&
      dto.records?.length
    ) {
      throw new BadRequestException(
        `Cannot mark attendance on a holiday: ${dayResolved.description ?? dayResolved.dayType ?? 'Day off'}`,
      );
    }

    // A SKIPPED session on an actual working day (almost always
    // auto-skipped by the cutoff-time job because nobody submitted it in
    // time, not a deliberate holiday/no-class decision — those stay
    // protected by the isWorkingDay check above) can be reopened by
    // marking it. This is routine correction of a missed roll call, not
    // an exceptional admin override.
    if (session.status === 'SKIPPED') {
      if (!dto.records?.length) {
        throw new BadRequestException('Cannot modify a skipped roll session');
      }
      await this.prisma.attendance_roll_sessions.update({
        where: { id },
        data: { status: 'DRAFT', skip_reason: null },
      });
    }

    if (dto.records?.length) {
      const roster = await this.getRosterStudents(
        session.campus_id,
        session.class_id,
        session.section_id,
        session.teaching_group_id,
      );
      const rosterCcs = new Set(roster.map((s) => s.cc));

      for (const mark of dto.records) {
        if (!rosterCcs.has(mark.student_cc)) {
          throw new BadRequestException(
            `Student CC ${mark.student_cc} is not in this class/section roster`,
          );
        }
        await this.prisma.attendance_roll_records.upsert({
          where: {
            session_id_student_cc: {
              session_id: id,
              student_cc: mark.student_cc,
            },
          },
          create: {
            session_id: id,
            student_cc: mark.student_cc,
            status: mark.status,
            notes: mark.notes,
          },
          update: {
            status: mark.status,
            notes: mark.notes,
          },
        });
      }
    }

    if (dto.submit) {
      const recordCount = await this.prisma.attendance_roll_records.count({
        where: { session_id: id },
      });
      const rosterCount = session.teaching_group_id
        ? await this.prisma.student_subject_enrollments.count({
            where: {
              teaching_group_id: session.teaching_group_id,
              students: { status: ENROLLED, deleted_at: null },
            },
          })
        : await this.prisma.students.count({
            where: {
              campus_id: session.campus_id,
              class_id: session.class_id,
              section_id: session.section_id,
              status: ENROLLED,
              deleted_at: null,
            },
          });

      if (recordCount < rosterCount) {
        throw new BadRequestException(
          `All ${rosterCount} students must be marked before submitting (${recordCount} marked)`,
        );
      }

      await this.prisma.attendance_roll_sessions.update({
        where: { id },
        data: {
          status: 'SUBMITTED',
          submitted_by_id: user.sub,
          submitted_at: new Date(),
        },
      });

      void this.auditLogs.log({
        entity_type: 'ROLL_SESSION',
        entity_id: String(id),
        action: 'UPDATED',
        field: 'status',
        old_value: session.status,
        new_value: 'SUBMITTED',
        changed_by: auditActorLabel(user),
        note: `Roll session #${id} submitted (${recordCount}/${rosterCount} marked).`,
      });

      // Fire-and-forget: a failure in the parent/admin announcement fan-out
      // (socket emit, FCM, chat message write) must not fail the request —
      // the attendance itself is already committed at this point.
      void this.announcements
        .announceSessionTaken(id)
        .catch((e) =>
          console.error(`Roll session #${id}: announceSessionTaken failed`, e),
        );

      if (session.session_kind === RollSessionKind.MAKEUP) {
        const completion = await this.reschedules.completeOnMakeupSubmit(id, user);
        const result = await this.findOne(id, user);
        return { ...result, reschedule_completion: completion };
      }
    }

    return this.findOne(id, user);
  }

  /** Undo a submitted roll call so attendance can be corrected or the calendar status restored. */
  async revert(id: number, user: IJwtStaffPayload) {
    const session = await this.prisma.attendance_roll_sessions.findUnique({
      where: { id },
    });
    if (!session) {
      throw new NotFoundException(`Roll session ${id} not found`);
    }
    this.assertCampusAccess(user, session.campus_id);
    assertClassInScope(user, session.class_id);

    if (session.status !== RollSessionStatus.SUBMITTED) {
      throw new BadRequestException('Only submitted roll sessions can be reverted');
    }

    const completedReschedules = await this.prisma.class_session_reschedules.findMany({
      where: {
        status: 'COMPLETED',
        OR: [{ makeup_roll_session_id: id }, { source_roll_session_id: id }],
      },
      select: { id: true },
    });

    for (const row of completedReschedules) {
      await this.reschedules.reverse(row.id, user);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.attendance_roll_records.deleteMany({ where: { session_id: id } });
      await tx.attendance_roll_sessions.update({
        where: { id },
        data: {
          status: RollSessionStatus.DRAFT,
          submitted_by_id: null,
          submitted_at: null,
        },
      });
    });

    void this.auditLogs.log({
      entity_type: 'ROLL_SESSION',
      entity_id: String(id),
      action: 'UPDATED',
      field: 'status',
      old_value: 'SUBMITTED',
      new_value: 'DRAFT',
      changed_by: auditActorLabel(user),
      note: `Roll session #${id} reverted to draft.`,
    });

    return this.findOne(id, user);
  }

  async skip(id: number, dto: SkipRollSessionDto, user: IJwtStaffPayload) {
    const session = await this.prisma.attendance_roll_sessions.findUnique({
      where: { id },
    });
    if (!session) {
      throw new NotFoundException(`Roll session ${id} not found`);
    }
    this.assertCampusAccess(user, session.campus_id);
    assertClassInScope(user, session.class_id);

    if (session.status === 'SUBMITTED') {
      throw new BadRequestException('Cannot skip a submitted roll session');
    }

    await this.prisma.attendance_roll_sessions.update({
      where: { id },
      data: {
        status: 'SKIPPED',
        skip_reason: dto.reason,
        submitted_by_id: user.sub,
        submitted_at: new Date(),
      },
    });

    void this.auditLogs.log({
      entity_type: 'ROLL_SESSION',
      entity_id: String(id),
      action: 'UPDATED',
      field: 'status',
      old_value: session.status,
      new_value: 'SKIPPED',
      changed_by: auditActorLabel(user),
      note: `Roll session #${id} skipped: ${dto.reason || 'no reason'}.`,
    });

    void this.announcements
      .announceSessionSkipped(id)
      .catch((e) =>
        console.error(`Roll session #${id}: announceSessionSkipped failed`, e),
      );
    return this.findOne(id, user);
  }

  async autoSkipMissedSessions(): Promise<number> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const campuses = await this.prisma.campuses.findMany({ select: { id: true } });
    let skipped = 0;

    for (const campus of campuses) {
      const cutoffTime = await this.getCutoffTime(campus.id);
      const now = new Date();
      const [h, m] = cutoffTime.split(':').map(Number);
      const cutoff = new Date(today);
      cutoff.setHours(h, m ?? 0, 0, 0);
      if (now < cutoff) continue;

      const rollCallClassIds = await this.getRollCallClassIds();
      const draftSessions = await this.prisma.attendance_roll_sessions.findMany({
        where: {
          campus_id: campus.id,
          session_date: today,
          status: 'DRAFT',
          class_id: { in: rollCallClassIds },
        },
      });

      for (const session of draftSessions) {
        if (await this.reschedules.hasScheduledRescheduleForSession(session)) {
          continue;
        }

        const dayResolved = await this.calendarResolver.resolveStudentDay(
          campus.id,
          session.class_id,
          session.section_id,
          today,
        );
        const reason = !this.isRollCallWorkingDay(dayResolved, today)
          ? `Holiday: ${dayResolved.description ?? dayResolved.dayType ?? 'Day off'}`
          : `Auto-skipped: roll call not submitted by ${cutoffTime}`;

        await this.prisma.attendance_roll_sessions.update({
          where: { id: session.id },
          data: {
            status: 'SKIPPED',
            skip_reason: reason,
            submitted_at: new Date(),
          },
        });
        await this.announcements.announceSessionSkipped(session.id);
        skipped++;
      }
    }

    return skipped;
  }

  private async getCutoffTime(campusId: number): Promise<string> {
    const policySet = await this.prisma.hr_policy_sets.findFirst({
      where: { campus_id: campusId },
      orderBy: { effective_from: 'desc' },
      include: {
        hr_policy_rules: { where: { rule_type: 'ROLLCALL_SESSION_CUTOFF_TIME' } },
      },
    });
    const rule = policySet?.hr_policy_rules?.[0];
    const val = rule?.value_json as { time?: string } | undefined;
    return val?.time ?? '16:00';
  }
}
