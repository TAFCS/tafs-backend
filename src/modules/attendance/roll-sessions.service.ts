import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RollSessionStatus, student_status } from '@prisma/client';
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

/** Fallback IDs used only when no class_attendance_modes rows exist yet. */
const DEFAULT_ROLL_CALL_CLASS_IDS = [21, 22];
const ENROLLED: student_status = 'ENROLLED';

@Injectable()
export class RollSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly announcements: RollCallAnnouncementsService,
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
    };

    return this.prisma.attendance_roll_sessions.findMany({
      where,
      include: this.sessionInclude(),
      orderBy: [{ class_id: 'asc' }, { section_id: 'asc' }, { period: 'asc' }],
    });
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
    return this.enrichWithRoster(session);
  }

  private async getRosterStudents(
    campusId: number,
    classId: number,
    sectionId: number,
  ) {
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

  private async enrichWithRoster(session: any) {
    const roster = await this.getRosterStudents(
      session.campus_id,
      session.class_id,
      session.section_id,
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
    this.assertCampusAccess(user, dto.campus_id);
    assertClassInScope(user, dto.class_id);
    await this.assertRollCallClass(dto.class_id);
    await this.assertCampusSection(dto.campus_id, dto.class_id, dto.section_id);

    const sessionDate = this.parseDate(dto.session_date);
    const period = dto.period ?? 1;

    const existing = await this.prisma.attendance_roll_sessions.findUnique({
      where: {
        campus_id_class_id_section_id_session_date_period: {
          campus_id: dto.campus_id,
          class_id: dto.class_id,
          section_id: dto.section_id,
          session_date: sessionDate,
          period,
        },
      },
      include: this.sessionInclude(),
    });

    if (existing) {
      return this.enrichWithRoster(existing);
    }

    const session = await this.prisma.attendance_roll_sessions.create({
      data: {
        campus_id: dto.campus_id,
        class_id: dto.class_id,
        section_id: dto.section_id,
        session_date: sessionDate,
        period,
        created_by_id: user.sub,
      },
      include: this.sessionInclude(),
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

    if (session.status === 'SKIPPED') {
      throw new BadRequestException('Cannot modify a skipped roll session');
    }

    if (session.status === 'SUBMITTED' && !canEditLocked) {
      throw new ForbiddenException(
        'This roll session is locked. You need attendance.student.edit_locked permission to edit.',
      );
    }

    if (dto.records?.length) {
      const roster = await this.getRosterStudents(
        session.campus_id,
        session.class_id,
        session.section_id,
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
      const rosterCount = await this.prisma.students.count({
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

      await this.announcements.announceSessionTaken(id);
    }

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

    await this.announcements.announceSessionSkipped(id);
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
        const reason = `Auto-skipped: roll call not submitted by ${cutoffTime}`;
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
