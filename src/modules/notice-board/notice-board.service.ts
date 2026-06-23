import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import * as path from 'path';

@Injectable()
export class NoticeBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly fcm: FcmService,
  ) {}

  // ── Family-facing ────────────────────────────────────────────────────────

  async getPostsForFamily(familyId: number, cursor?: number) {
    const students = await this.prisma.students.findMany({
      where: { family_id: familyId, deleted_at: null },
      select: { campus_id: true, class_id: true, section_id: true },
    });

    const campusIds = [...new Set(students.map((s) => s.campus_id).filter(Boolean))] as number[];
    const classIds  = [...new Set(students.map((s) => s.class_id).filter(Boolean))] as number[];
    const sectionIds = [...new Set(students.map((s) => s.section_id).filter(Boolean))] as number[];

    const posts = await this.prisma.notice_board_posts.findMany({
      where: {
        deleted_at: null,
        AND: [
          {
            OR: [
              { campus_ids: { isEmpty: true } },
              ...(campusIds.length ? [{ campus_ids: { hasSome: campusIds } }] : []),
            ],
          },
          {
            OR: [
              { class_ids: { isEmpty: true } },
              ...(classIds.length ? [{ class_ids: { hasSome: classIds } }] : []),
            ],
          },
          {
            OR: [
              { section_ids: { isEmpty: true } },
              ...(sectionIds.length ? [{ section_ids: { hasSome: sectionIds } }] : []),
            ],
          },
          {
            OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
          },
        ],
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: [{ is_pinned: 'desc' }, { posted_at: 'desc' }],
      include: {
        post_reads: {
          where: { family_id: familyId },
          select: { read_at: true },
        },
        users: { select: { full_name: true } },
      },
      take: 20,
    });

    return posts;
  }

  async markRead(postId: number, familyId: number) {
    await this.prisma.notice_post_reads.upsert({
      where: { post_id_family_id: { post_id: postId, family_id: familyId } },
      create: { post_id: postId, family_id: familyId },
      update: {},
    });
  }

  // ── Admin-facing ─────────────────────────────────────────────────────────

  async getAllPosts(cursor?: number) {
    const posts = await this.prisma.notice_board_posts.findMany({
      where: {
        deleted_at: null,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: [{ is_pinned: 'desc' }, { posted_at: 'desc' }],
      include: {
        users: { select: { full_name: true } },
        _count: { select: { post_reads: true } },
      },
      take: 30,
    });

    const holidays = await this.prisma.academic_calendar_days.findMany({
      where: {
        applies_to: 'STUDENT',
        day_type: 'HOLIDAY',
      },
      orderBy: { date: 'desc' },
      take: 30,
    });

    const userIds = holidays.map((h) => h.created_by).filter((cb): cb is string => !!cb);
    const creators = userIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: userIds } },
          select: { id: true, full_name: true },
        })
      : [];
    const creatorMap = new Map(creators.map((u) => [u.id, u.full_name]));

    const holidayPosts = holidays.map((h) => {
      const isPinned = h.description?.startsWith('[PINNED] ') ?? false;
      const cleanDesc = isPinned ? h.description!.replace('[PINNED] ', '') : (h.description || 'Holiday');
      const creatorName = h.created_by ? creatorMap.get(h.created_by) : null;
      return {
        id: `holiday-${h.id}` as any, // Cast to any to satisfy type signature of notice board posts
        posted_by: h.created_by || 'System',
        title: 'School Closed',
        body: `${cleanDesc} (on ${new Date(h.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })})`,
        campus_ids: [h.campus_id],
        class_ids: h.class_id ? [h.class_id] : [],
        section_ids: h.section_id ? [h.section_id] : [],
        media_urls: [],
        media_types: [],
        is_pinned: isPinned,
        posted_at: h.date,
        expires_at: null,
        deleted_at: null,
        users: { full_name: creatorName || h.created_by || 'System' },
        _count: { post_reads: 0 },
      };
    });

    const merged = [...posts, ...holidayPosts];
    merged.sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      return new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime();
    });

    return merged;
  }

  async createPost(postedBy: string, dto: CreatePostDto) {
    const post = await this.prisma.notice_board_posts.create({
      data: {
        posted_by: postedBy,
        title: dto.title,
        body: dto.body,
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

    // Fire-and-forget push notifications to all scoped families
    this._sendPostNotifications(post).catch((err) =>
      console.error('Notice board FCM dispatch failed:', err.message),
    );

    return post;
  }

  private async _sendPostNotifications(post: {
    id: number;
    title: string | null;
    body: string;
    campus_ids: unknown;
    class_ids: unknown;
    section_ids: unknown;
  }) {
    const campusIds = (post.campus_ids as number[]) ?? [];
    const classIds  = (post.class_ids as number[])  ?? [];
    const sectionIds = (post.section_ids as number[]) ?? [];

    const families = await this.prisma.families.findMany({
      where: {
        deleted_at: null,
        students: {
          some: {
            deleted_at: null,
            AND: [
              campusIds.length  ? { campus_id:  { in: campusIds  } } : {},
              classIds.length   ? { class_id:   { in: classIds   } } : {},
              sectionIds.length ? { section_id: { in: sectionIds } } : {},
            ],
          },
        },
      },
      select: { id: true },
    });

    const title = post.title ?? 'New School Notice';
    const body  = post.body.length > 120 ? post.body.slice(0, 117) + '…' : post.body;
    const data  = { type: 'notice_board', post_id: String(post.id) };

    await Promise.allSettled(
      families.map((f) => this.fcm.sendToFamily(f.id, title, body, data)),
    );
  }

  async updatePost(id: string | number, dto: UpdatePostDto) {
    if (String(id).startsWith('holiday-')) {
      const holidayId = parseInt(String(id).replace('holiday-', ''), 10);
      const h = await this.prisma.academic_calendar_days.findUnique({ where: { id: holidayId } });
      if (!h) throw new NotFoundException('Holiday not found');

      let newDesc = h.description || '';
      if (dto.is_pinned !== undefined) {
        const hasPin = newDesc.startsWith('[PINNED] ');
        if (dto.is_pinned && !hasPin) {
          newDesc = `[PINNED] ${newDesc}`;
        } else if (!dto.is_pinned && hasPin) {
          newDesc = newDesc.replace('[PINNED] ', '');
        }
      }

      const updated = await this.prisma.academic_calendar_days.update({
        where: { id: holidayId },
        data: {
          description: newDesc,
        },
      });

      return {
        id: `holiday-${updated.id}`,
        is_pinned: dto.is_pinned,
      };
    }

    const numericId = typeof id === 'number' ? id : parseInt(id, 10);
    const post = await this.prisma.notice_board_posts.findFirst({
      where: { id: numericId, deleted_at: null },
    });
    if (!post) throw new NotFoundException('Post not found');

    return this.prisma.notice_board_posts.update({
      where: { id: numericId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.is_pinned !== undefined && { is_pinned: dto.is_pinned }),
        ...(dto.expires_at !== undefined && {
          expires_at: dto.expires_at ? new Date(dto.expires_at) : null,
        }),
      },
    });
  }

  async deletePost(id: string | number) {
    if (String(id).startsWith('holiday-')) {
      const holidayId = parseInt(String(id).replace('holiday-', ''), 10);
      const deleted = await this.prisma.academic_calendar_days.delete({
        where: { id: holidayId },
      });

      // Delete the generated calendar notifications for this holiday from the mobile app feed
      await this.prisma.calendar_notifications.deleteMany({
        where: {
          date: deleted.date,
          alert_type: 'HOLIDAY',
          students: {
            campus_id: deleted.campus_id,
            ...(deleted.class_id ? { class_id: deleted.class_id } : {}),
            ...(deleted.section_id ? { section_id: deleted.section_id } : {}),
          },
        },
      });

      return { id: `holiday-${deleted.id}` };
    }

    const numericId = typeof id === 'number' ? id : parseInt(id, 10);
    const post = await this.prisma.notice_board_posts.findFirst({
      where: { id: numericId, deleted_at: null },
    });
    if (!post) throw new NotFoundException('Post not found');

    return this.prisma.notice_board_posts.update({
      where: { id: numericId },
      data: { deleted_at: new Date() },
    });
  }

  async getReadStats(postId: string | number) {
    if (String(postId).startsWith('holiday-')) {
      return {
        post_id: postId,
        total_reached: 0,
        total_read: 0,
      };
    }

    const numericId = typeof postId === 'number' ? postId : parseInt(postId, 10);
    const post = await this.prisma.notice_board_posts.findFirst({
      where: { id: numericId, deleted_at: null },
      select: {
        campus_ids: true,
        class_ids: true,
        section_ids: true,
        _count: { select: { post_reads: true } },
      },
    });
    if (!post) throw new NotFoundException('Post not found');

    // Count families whose students are in scope
    const campusIds = post.campus_ids as number[];
    const classIds  = post.class_ids as number[];
    const sectionIds = post.section_ids as number[];

    const scopedFamilies = await this.prisma.families.findMany({
      where: {
        deleted_at: null,
        students: {
          some: {
            deleted_at: null,
            AND: [
              campusIds.length ? { campus_id: { in: campusIds } } : {},
              classIds.length ? { class_id: { in: classIds } } : {},
              sectionIds.length ? { section_id: { in: sectionIds } } : {},
            ],
          },
        },
      },
      select: { id: true },
    });

    return {
      post_id: numericId,
      total_reached: scopedFamilies.length,
      total_read: post._count.post_reads,
    };
  }

  // ── Media upload ─────────────────────────────────────────────────────────

  async uploadMedia(file: Express.Multer.File): Promise<{ url: string; type: string }> {
    let folder = 'notice-board/misc';
    let type = 'misc';
    if (file.mimetype.startsWith('image/')) { folder = 'notice-board/images'; type = 'image'; }
    else if (file.mimetype.startsWith('video/')) { folder = 'notice-board/videos'; type = 'video'; }
    else if (file.mimetype === 'application/pdf') { folder = 'notice-board/docs'; type = 'pdf'; }

    const ext = path.extname(file.originalname);
    const key = `${folder}/${new Date().getFullYear()}/${Date.now()}${ext}`;
    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    return { url, type };
  }
}
