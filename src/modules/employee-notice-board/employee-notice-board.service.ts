import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { StaffRole } from '@prisma/client';
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
    return this.prisma.employee_notice_posts.findMany({
      where: {
        deleted_at: null,
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
              { expires_at: null },
              { expires_at: { gte: new Date() } },
            ],
          },
        ],
      },
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
    const posts = await this.prisma.employee_notice_posts.findMany({
      where: { deleted_at: null },
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
    void this._sendFcmNotifications(post, dto.target_roles ?? [], dto.campus_ids ?? []);

    return post;
  }

  async updatePost(id: number, dto: UpdateEmployeeNoticeDto) {
    const post = await this.prisma.employee_notice_posts.findFirst({
      where: { id, deleted_at: null },
    });
    if (!post) throw new NotFoundException('Employee notice not found');

    return this.prisma.employee_notice_posts.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.target_roles !== undefined && { target_roles: dto.target_roles }),
        ...(dto.campus_ids !== undefined && { campus_ids: dto.campus_ids }),
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
    this.auditLogs.log({ entity_type: 'EMPLOYEE_NOTICE', entity_id: String(id), action: 'DELETED', section: 'communication', old_value: post.title ?? undefined, changed_by: deletedBy ?? 'system' });
    return result;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _sendFcmNotifications(
    post: { id: number; title: string | null; body: string },
    targetRoles: StaffRole[],
    campusIds: number[],
  ) {
    try {
      const targets = await this.prisma.users.findMany({
        where: {
          is_active: true,
          deleted_at: null,
          ...(targetRoles.length ? { role: { in: targetRoles } } : {}),
          ...(campusIds.length ? { campus_id: { in: campusIds } } : {}),
        },
        select: { id: true },
      });

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
