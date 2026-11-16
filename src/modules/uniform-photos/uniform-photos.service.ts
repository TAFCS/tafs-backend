import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, StaffRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScopeService } from '../../common/scope/scope.service';
import { AccessService } from '../access/access.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { StaffNotificationsService } from '../staff-notifications/staff-notifications.service';
import {
  UNIFORM_PHOTO_ACTION,
  UNIFORM_PHOTO_ACTION_KEY,
  UNIFORM_PHOTO_FROM_CC,
  UNIFORM_PHOTO_LINK,
  UNIFORM_PHOTO_REMINDER_KIND,
  UNIFORM_PHOTO_STATUSES,
} from './uniform-photo.constants';

/**
 * TAFSD-527: new students still on their admission photo.
 *
 * Admission photos are almost always in house clothes, so every student
 * registered after Ayan Jahangir (CC 7525) carries `students.uniform_photo_pending`
 * until a school-uniform photo replaces the admission one. The flag is set and
 * cleared by the `trg_students_uniform_photo_pending` trigger (see its
 * migration), so every upload path clears it without knowing about it; this
 * service only reads it, lets a person override it, and sends the reminder.
 */

/** Midnight today in Pakistan time, as a UTC instant. */
export function startOfTodayPkt(now = new Date()): Date {
  const pkt = new Date(now.getTime() + 5 * 3600_000);
  return new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate()) - 5 * 3600_000);
}

export function reminderText(total: number, noPhoto: number, campuses: string[]) {
  const who = total === 1 ? '1 new student' : `${total} new students`;
  const where = campuses.length ? ` at ${campuses.join(', ')}` : '';
  const none = noPhoto > 0 ? ` (${noPhoto} with no photo at all)` : '';
  return {
    title: 'Uniform photos needed',
    body: `${who}${where} still ${total === 1 ? 'has' : 'have'} only the admission photo${none}. Upload a photo in school uniform to clear ${total === 1 ? 'it' : 'them'}.`,
  };
}

@Injectable()
export class UniformPhotosService {
  private readonly logger = new Logger(UniformPhotosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly access: AccessService,
    private readonly notifications: StaffNotificationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Students still waiting for a uniform photo, within `scopeWhere`. */
  pendingWhere(scopeWhere: Prisma.studentsWhereInput = {}): Prisma.studentsWhereInput {
    return {
      AND: [
        scopeWhere,
        {
          uniform_photo_pending: true,
          deleted_at: null,
          cc: { gte: UNIFORM_PHOTO_FROM_CC },
          status: { in: UNIFORM_PHOTO_STATUSES },
        },
      ],
    };
  }

  async summary(user: IJwtStaffPayload) {
    return this.summaryFor(this.scope.whereForStudents(user));
  }

  private async summaryFor(scopeWhere: Prisma.studentsWhereInput) {
    const rows = await this.prisma.students.findMany({
      where: this.pendingWhere(scopeWhere),
      select: { photograph_url: true, campuses: { select: { campus_code: true } } },
    });
    const byCampus = new Map<string, number>();
    let noPhoto = 0;
    for (const r of rows) {
      const code = r.campuses?.campus_code ?? '—';
      byCampus.set(code, (byCampus.get(code) ?? 0) + 1);
      if (!r.photograph_url?.trim()) noPhoto++;
    }
    return {
      total: rows.length,
      no_photo: noPhoto,
      by_campus: [...byCampus.entries()].sort().map(([campus_code, count]) => ({ campus_code, count })),
    };
  }

  /**
   * Overrides the flag by hand: `false` when the admission photo is already in
   * uniform, `true` to chase a photo that was replaced with another
   * house-clothes one.
   */
  async setPending(cc: number, pending: boolean, user: IJwtStaffPayload) {
    const student = await this.prisma.students.findFirst({
      where: { cc, deleted_at: null },
      select: { cc: true, full_name: true, uniform_photo_pending: true, campus_id: true, class_id: true, section_id: true },
    });
    if (!student || !this.scope.canSeeStudent(user, student)) {
      throw new NotFoundException(`Student with CC ${cc} not found`);
    }
    if (cc < UNIFORM_PHOTO_FROM_CC && pending) {
      throw new ForbiddenException('Uniform photo follow-up only applies to students after CC 7525.');
    }
    if (student.uniform_photo_pending === pending) return { cc, uniform_photo_pending: pending };

    await this.prisma.students.update({ where: { cc }, data: { uniform_photo_pending: pending } });
    void this.auditLogs.log({
      entity_type: 'STUDENT',
      entity_id: String(cc),
      action: 'UPDATED',
      field: 'uniform_photo_pending',
      old_value: String(student.uniform_photo_pending),
      new_value: String(pending),
      changed_by: user.username,
      student_id: cc,
      note: pending
        ? `Marked CC ${cc} (${student.full_name}) as still needing a school uniform photo.`
        : `Marked the photo of CC ${cc} (${student.full_name}) as already in school uniform.`,
    });
    return { cc, uniform_photo_pending: pending };
  }

  /**
   * People who asked for the reminder: an explicit tick on the action, for the
   * person or through a pack. Holding it only through the legacy directory
   * edit bridge, or by being SUPER_ADMIN, does not sign anyone up.
   */
  async recipients(): Promise<string[]> {
    const [direct, viaPack] = await Promise.all([
      this.prisma.user_tile_action_grants.findMany({
        where: { tile_id: UNIFORM_PHOTO_ACTION.tileId, action_id: UNIFORM_PHOTO_ACTION.actionId, allow: true },
        select: { user_id: true },
      }),
      this.prisma.user_access_packs.findMany({
        where: {
          pack: {
            tile_actions: {
              some: { tile_id: UNIFORM_PHOTO_ACTION.tileId, action_id: UNIFORM_PHOTO_ACTION.actionId },
            },
          },
        },
        select: { user_id: true },
      }),
    ]);
    const candidates = [...new Set([...direct, ...viaPack].map((r) => r.user_id))];
    const holders: string[] = [];
    for (const userId of candidates) {
      // A deny on the action or the tile, or a deactivated login, wins.
      const session = await this.access.resolveLiveSession(userId);
      if (session?.isActive && session.actionIds.includes(UNIFORM_PHOTO_ACTION_KEY)) holders.push(userId);
    }
    return holders;
  }

  /**
   * The morning reminder. One notification per holder per day, counting only
   * the students they can see; nobody hears about a count of zero. Safe to run
   * twice (another instance, a manual re-run): a holder already reminded today
   * is skipped.
   */
  async sendDailyReminders(now = new Date()) {
    const sentSince = startOfTodayPkt(now);
    const result = { recipients: 0, notified: 0, skipped_already_sent: 0, skipped_nothing_pending: 0 };
    for (const userId of await this.recipients()) {
      result.recipients++;
      const already = await this.prisma.staff_notifications.count({
        where: { user_id: userId, kind: UNIFORM_PHOTO_REMINDER_KIND, created_at: { gte: sentSince } },
      });
      if (already) {
        result.skipped_already_sent++;
        continue;
      }
      const user = await this.prisma.users.findUnique({ where: { id: userId }, select: { role: true } });
      if (!user) continue;
      const scope = await this.scope.resolveEffective(userId);
      const scopeWhere =
        user.role === StaffRole.SUPER_ADMIN ? {} : this.scope.whereForStudents({ role: user.role, scope });
      const summary = await this.summaryFor(scopeWhere);
      if (summary.total === 0) {
        result.skipped_nothing_pending++;
        continue;
      }
      const text = reminderText(summary.total, summary.no_photo, summary.by_campus.map((c) => c.campus_code));
      await this.notifications.notify(userId, {
        kind: UNIFORM_PHOTO_REMINDER_KIND,
        ...text,
        link: UNIFORM_PHOTO_LINK,
        entityType: 'UNIFORM_PHOTO',
        pushData: { link: UNIFORM_PHOTO_LINK },
      });
      result.notified++;
    }
    this.logger.log(`Uniform photo reminders: ${JSON.stringify(result)}`);
    return result;
  }
}
