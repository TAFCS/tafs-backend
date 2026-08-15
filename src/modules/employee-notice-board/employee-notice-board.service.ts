import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { Prisma, StaffRole } from '@prisma/client';
import { CreateEmployeeNoticeDto } from './dto/create-employee-notice.dto';
import { UpdateEmployeeNoticeDto } from './dto/update-employee-notice.dto';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@Injectable()
export class EmployeeNoticeBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly fcmService: FcmService,
  ) {}

  // ── Employee-facing ──────────────────────────────────────────────────────

  async getFeedForUser(user: IJwtStaffPayload) {
    const profile = await this.prisma.employee_profiles.findFirst({
      where: { user_id: user.sub },
      select: { id: true, employee_class_section_assignments: { select: { class_id: true, section_id: true } } },
    });
    const assignedClassIds = [...new Set(profile?.employee_class_section_assignments.map(a => a.class_id) ?? [])];
    const assignedSectionIds = [...new Set(profile?.employee_class_section_assignments.map(a => a.section_id) ?? [])];

    // Personal posts (e.g. a check-in/check-out ping) are always visible to
    // their addressee, independent of the broadcast targeting below.
    const orConditions: Prisma.employee_notice_postsWhereInput[] = [
      {
        employee_id: null,
        AND: [
          {
            OR: [
              { target_roles: { isEmpty: true } },
              { target_roles: { has: user.role as StaffRole } },
            ],
          },
          {
            OR: [
              { campus_ids: { isEmpty: true } },
              ...(user.campusId != null
                ? [{ campus_ids: { has: user.campusId } }]
                : []),
            ],
          },
          {
            OR: [
              { class_ids: { isEmpty: true } },
              ...(assignedClassIds.length ? [{ class_ids: { hasSome: assignedClassIds } }] : []),
            ],
          },
          {
            OR: [
              { section_ids: { isEmpty: true } },
              ...(assignedSectionIds.length ? [{ section_ids: { hasSome: assignedSectionIds } }] : []),
            ],
          },
          {
            OR: [
              { expires_at: null },
              { expires_at: { gte: new Date() } },
            ],
          },
        ],
      },
    ];
    if (profile?.id != null) {
      orConditions.push({ employee_id: profile.id });
    }

    return this.prisma.employee_notice_posts.findMany({
      where: { deleted_at: null, OR: orConditions },
      include: {
        users: { select: { full_name: true } },
        post_reads: {
          where: { user_id: user.sub },
          select: { read_at: true },
        },
      },
      orderBy: [{ is_pinned: 'desc' }, { posted_at: 'desc' }],
      take: 50,
    });
  }

  async markRead(postId: number, userId: string) {
    await this.prisma.employee_notice_post_reads.upsert({
      where: { post_id_user_id: { post_id: postId, user_id: userId } },
      create: { post_id: postId, user_id: userId },
      update: {},
    });
    return { ok: true };
  }

  // ── Admin-facing ─────────────────────────────────────────────────────────

  async getAdminList() {
    // System-generated personal posts (e.g. check-in/check-out pings) aren't
    // admin-authored content — they don't belong in the composer's manage list.
    const posts = await this.prisma.employee_notice_posts.findMany({
      where: { deleted_at: null, employee_id: null },
      orderBy: [{ is_pinned: 'desc' }, { posted_at: 'desc' }],
      include: {
        users: { select: { full_name: true } },
        _count: { select: { post_reads: true } },
      },
      take: 100,
    });

    // Attach total_reached per post (count of active users that match scope)
    const withReached = await Promise.all(
      posts.map(async (post) => {
        const targetRoles = post.target_roles as StaffRole[];
        const campusIds = post.campus_ids as number[];
        const total_reached = await this.prisma.users.count({
          where: {
            is_active: true,
            deleted_at: null,
            ...(targetRoles.length ? { role: { in: targetRoles } } : {}),
            ...(campusIds.length ? { campus_id: { in: campusIds } } : {}),
          },
        });
        return { ...post, total_reached };
      }),
    );

    return withReached;
  }

  async createPost(dto: CreateEmployeeNoticeDto, user: IJwtStaffPayload, changedBy?: string) {
    const post = await this.prisma.employee_notice_posts.create({
      data: {
        posted_by: user.sub,
        title: dto.title,
        body: dto.body,
        target_roles: dto.target_roles ?? [],
        campus_ids: dto.campus_ids ?? [],
        class_ids: dto.class_ids ?? [],
        section_ids: dto.section_ids ?? [],
        media_urls: dto.media_urls ?? [],
        media_types: dto.media_types ?? [],
        is_pinned: dto.is_pinned ?? false,
        expires_at: dto.expires_at ? new Date(dto.expires_at) : null,
      },
      include: {
        users: { select: { full_name: true } },
        _count: { select: { post_reads: true } },
      },
    });

    const noteParts = [`Title: ${dto.title}`];
    if (dto.body) noteParts.push(`Body: ${dto.body.slice(0, 120)}${dto.body.length > 120 ? '…' : ''}`);
    if (dto.target_roles?.length) noteParts.push(`Roles: ${dto.target_roles.join(', ')}`);
    if (dto.campus_ids?.length) noteParts.push(`Campuses: ${dto.campus_ids.join(', ')}`);
    if (dto.is_pinned) noteParts.push('Pinned');
    this.auditLogs.log({ entity_type: 'EMPLOYEE_NOTICE', entity_id: String(post.id), action: 'CREATED', section: 'communication', note: noteParts.join(' | '), changed_by: changedBy || user.username || user.sub });

    // Fan-out FCM — fire and forget
    void this._sendFcmNotifications(post, dto.target_roles ?? [], dto.campus_ids ?? [], dto.class_ids ?? [], dto.section_ids ?? []);

    return post;
  }

  async updatePost(id: number, dto: UpdateEmployeeNoticeDto, changedBy?: string) {
    const post = await this.prisma.employee_notice_posts.findFirst({
      where: { id, deleted_at: null },
    });
    if (!post) throw new NotFoundException('Employee notice not found');

    const updated = await this.prisma.employee_notice_posts.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.target_roles !== undefined && { target_roles: dto.target_roles }),
        ...(dto.campus_ids !== undefined && { campus_ids: dto.campus_ids }),
        ...(dto.class_ids !== undefined && { class_ids: dto.class_ids }),
        ...(dto.section_ids !== undefined && { section_ids: dto.section_ids }),
        ...(dto.is_pinned !== undefined && { is_pinned: dto.is_pinned }),
        ...(dto.expires_at !== undefined && {
          expires_at: dto.expires_at ? new Date(dto.expires_at) : null,
        }),
      },
      include: {
        users: { select: { full_name: true } },
        _count: { select: { post_reads: true } },
      },
    });

    const changes: string[] = [];
    if (dto.title !== undefined && post.title !== updated.title) {
      changes.push(`title "${post.title ?? '—'}" → "${updated.title ?? '—'}"`);
    }
    if (dto.body !== undefined && post.body !== updated.body) {
      changes.push(`body changed`);
    }
    if (dto.is_pinned !== undefined && post.is_pinned !== updated.is_pinned) {
      changes.push(`is_pinned ${post.is_pinned} → ${updated.is_pinned}`);
    }
    if (dto.target_roles !== undefined) {
      changes.push(`roles [${(post.target_roles as any[])?.join(', ') ?? ''}] → [${(dto.target_roles ?? []).join(', ')}]`);
    }
    if (dto.campus_ids !== undefined) {
      changes.push(`campuses [${(post.campus_ids as any[])?.join(', ') ?? ''}] → [${(dto.campus_ids ?? []).join(', ')}]`);
    }
    if (dto.expires_at !== undefined) {
      const oldExp = post.expires_at?.toISOString() ?? null;
      const newExp = updated.expires_at?.toISOString() ?? null;
      if (oldExp !== newExp) {
        changes.push(`expires_at "${oldExp ?? '—'}" → "${newExp ?? '—'}"`);
      }
    }

    if (changes.length > 0) {
      await this.auditLogs.log({
        entity_type: 'EMPLOYEE_NOTICE',
        entity_id: String(id),
        action: 'UPDATED',
        section: 'communication',
        changed_by: changedBy ?? 'system',
        note: `Employee notice #${id} ("${post.title ?? 'untitled'}") updated: ${changes.join(', ')}.`,
      });
    }

    return updated;
  }

  async deletePost(id: number, deletedBy?: string) {
    const post = await this.prisma.employee_notice_posts.findFirst({
      where: { id, deleted_at: null },
    });
    if (!post) throw new NotFoundException('Employee notice not found');

    const result = await this.prisma.employee_notice_posts.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    await this.auditLogs.log({
      entity_type: 'EMPLOYEE_NOTICE',
      entity_id: String(id),
      action: 'DELETED',
      section: 'communication',
      old_value: post.title ?? post.body?.slice(0, 80),
      note: `Deleted "${post.title?.trim() || 'untitled'}" | Body: ${(post.body ?? '').slice(0, 120)}${(post.body?.length ?? 0) > 120 ? '…' : ''}`,
      changed_by: deletedBy ?? 'system',
    });
    return result;
  }

  // ── System-generated (e.g. biometric check-in/check-out) ───────────────────

  /**
   * Posts a personal, single-recipient notice — visible only to `employeeId`
   * via the employee_id branch in getFeedForUser, and excluded from the admin
   * composer's manage list. Self-authored (posted_by = the employee's own
   * user id) since there's no dedicated "system" user account.
   */
  async createAttendanceNotice(employeeId: number, userId: string, title: string, body: string) {
    const post = await this.prisma.employee_notice_posts.create({
      data: { posted_by: userId, employee_id: employeeId, title, body },
    });

    await this.auditLogs.log({
      entity_type: 'EMPLOYEE_NOTICE',
      entity_id: String(post.id),
      action: 'CREATED',
      section: 'communication',
      changed_by: 'system',
      note: `Attendance notice #${post.id} created for employee #${employeeId}: "${title}" — ${body.slice(0, 120)}${body.length > 120 ? '…' : ''}.`,
    });

    void this.fcmService
      .sendToUsers([userId], title, body, { type: 'EMPLOYEE_NOTICE', postId: String(post.id) })
      .catch((err) => console.error('[EmployeeNoticeBoard] Attendance notice FCM send failed:', err?.message));

    return post;
  }

  /** Same personal, single-recipient notice pattern as createAttendanceNotice, for HR calendar/schedule override events (day off, working-day override, shift-time change, mandatory Saturday). */
  async createScheduleNotice(employeeId: number, userId: string, title: string, body: string) {
    const post = await this.prisma.employee_notice_posts.create({
      data: { posted_by: userId, employee_id: employeeId, title, body },
    });

    await this.auditLogs.log({
      entity_type: 'EMPLOYEE_NOTICE',
      entity_id: String(post.id),
      action: 'CREATED',
      section: 'communication',
      changed_by: 'system',
      note: `Schedule notice #${post.id} created for employee #${employeeId}: "${title}" — ${body.slice(0, 120)}${body.length > 120 ? '…' : ''}.`,
    });

    void this.fcmService
      .sendToUsers([userId], title, body, { type: 'EMPLOYEE_NOTICE', postId: String(post.id) })
      .catch((err) => console.error('[EmployeeNoticeBoard] Schedule notice FCM send failed:', err?.message));

    return post;
  }

  /** Same personal, single-recipient notice pattern as createAttendanceNotice, for payroll finalize/settle events. */
  async createPayrollNotice(employeeId: number, userId: string, title: string, body: string, payrollRunId: number) {
    const post = await this.prisma.employee_notice_posts.create({
      data: { posted_by: userId, employee_id: employeeId, title, body },
    });

    await this.auditLogs.log({
      entity_type: 'EMPLOYEE_NOTICE',
      entity_id: String(post.id),
      action: 'CREATED',
      section: 'communication',
      changed_by: 'system',
      note: `Payroll notice #${post.id} created for employee #${employeeId}: "${title}" — ${body.slice(0, 120)}${body.length > 120 ? '…' : ''}.`,
    });

    void this.fcmService
      .sendToUsers([userId], title, body, { type: 'PAYROLL', postId: String(post.id), runId: String(payrollRunId) })
      .catch((err) => console.error('[EmployeeNoticeBoard] Payroll notice FCM send failed:', err?.message));

    return post;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _sendFcmNotifications(
    post: { id: number; title: string | null; body: string },
    targetRoles: StaffRole[],
    campusIds: number[],
    classIds: number[] = [],
    sectionIds: number[] = [],
  ) {
    try {
      const hasClassOrSection = classIds.length > 0 || sectionIds.length > 0;

      let targets: { id: string }[];

      if (hasClassOrSection) {
        const profiles = await this.prisma.employee_profiles.findMany({
          where: {
            users: {
              is_active: true,
              deleted_at: null,
              ...(targetRoles.length ? { role: { in: targetRoles } } : {}),
              ...(campusIds.length ? { campus_id: { in: campusIds } } : {}),
            },
            employee_class_section_assignments: {
              some: {
                ...(classIds.length ? { class_id: { in: classIds } } : {}),
                ...(sectionIds.length ? { section_id: { in: sectionIds } } : {}),
              },
            },
          },
          select: { user_id: true },
        });
        targets = profiles
          .filter((p) => p.user_id != null)
          .map((p) => ({ id: p.user_id! }));
      } else {
        targets = await this.prisma.users.findMany({
          where: {
            is_active: true,
            deleted_at: null,
            ...(targetRoles.length ? { role: { in: targetRoles } } : {}),
            ...(campusIds.length ? { campus_id: { in: campusIds } } : {}),
          },
          select: { id: true },
        });
      }

      if (!targets.length) return;

      const title = post.title ?? 'New Employee Notice';
      const body = post.body.length > 120 ? post.body.slice(0, 117) + '…' : post.body;
      const data = { type: 'EMPLOYEE_NOTICE', postId: String(post.id) };

      await Promise.allSettled(
        targets.map((u) => this.fcmService.sendToUsers([u.id], title, body, data)),
      );
    } catch (err: any) {
      console.error('[EmployeeNoticeBoard] FCM fan-out failed:', err?.message);
    }
  }
}
