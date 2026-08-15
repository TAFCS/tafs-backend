import { Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { student_status } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ChatGateway } from '../chat/chat.gateway';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import * as path from 'path';

@Injectable()
export class NoticeBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly fcm: FcmService,
    private readonly auditLogs: AuditLogsService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
  ) {}

  // ── Family-facing ────────────────────────────────────────────────────────

  async getPostsForFamily(familyId: number, cursor?: number) {
    const students = await this.prisma.students.findMany({
      where: { family_id: familyId, deleted_at: null },
      select: { cc: true, campus_id: true, class_id: true, section_id: true, status: true, academic_year: true },
    });

    const studentCcs = students.map((s) => s.cc);
    const campusIds = [...new Set(students.map((s) => s.campus_id).filter(Boolean))] as number[];
    const classIds  = [...new Set(students.map((s) => s.class_id).filter(Boolean))] as number[];
    const sectionIds = [...new Set(students.map((s) => s.section_id).filter(Boolean))] as number[];
    const statuses = [...new Set(students.map((s) => s.status).filter(Boolean))];
    const academicYears = [...new Set(students.map((s) => s.academic_year).filter(Boolean))] as string[];

    const scopeFilter = {
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
          OR: [
            { student_statuses: { isEmpty: true } },
            ...(statuses.length ? [{ student_statuses: { hasSome: statuses } }] : []),
          ],
        },
        {
          OR: [
            { academic_years: { isEmpty: true } },
            ...(academicYears.length ? [{ academic_years: { hasSome: academicYears } }] : []),
          ],
        },
      ],
      student_ccs: { isEmpty: true },
    };

    const posts = await this.prisma.notice_board_posts.findMany({
      where: {
        deleted_at: null,
        notification_only: false,
        OR: [
          ...(studentCcs.length ? [{ student_ccs: { hasSome: studentCcs } }] : []),
          scopeFilter,
        ],
        AND: [
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

    const allStudentCcs = [...new Set(posts.flatMap((p) => p.student_ccs || []))];
    const students = allStudentCcs.length
      ? await this.prisma.students.findMany({
          where: { cc: { in: allStudentCcs } },
          select: {
            cc: true,
            full_name: true,
            gr_number: true,
            families: { select: { household_name: true } },
          },
        })
      : [];
    const studentMap = new Map(
      students.map((s) => [
        s.cc,
        {
          cc: s.cc,
          full_name: s.full_name,
          gr_number: s.gr_number,
          household_name: s.families?.household_name || null,
        },
      ]),
    );

    const postsWithStudents = posts.map((post) => ({
      ...post,
      targeted_students: (post.student_ccs || [])
        .map((cc) => studentMap.get(cc))
        .filter(Boolean),
    }));

    let schoolWideReached: number | null = null;
    const postsWithReach = await Promise.all(
      postsWithStudents.map(async (post) => {
        if (this._isSchoolWide(post)) {
          if (schoolWideReached == null) {
            schoolWideReached = await this._countAudienceFamilies(post);
          }
          return { ...post, total_reached: schoolWideReached };
        }
        return {
          ...post,
          total_reached: await this._countAudienceFamilies(post),
        };
      }),
    );

    const holidays = await this.prisma.academic_calendar_days.findMany({
      where: {
        applies_to: 'STUDENT',
        day_type: { in: ['HOLIDAY', 'WORKDAY'] },
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
      const defaultDesc = h.day_type === 'WORKDAY' ? 'School Open' : 'Holiday';
      const cleanDesc = isPinned ? h.description!.replace('[PINNED] ', '') : (h.description || defaultDesc);
      const creatorName = h.created_by ? creatorMap.get(h.created_by) : null;
      const title = h.day_type === 'WORKDAY' ? 'School Open' : 'School Closed';
      return {
        id: `holiday-${h.id}` as any, // Cast to any to satisfy type signature of notice board posts
        posted_by: h.created_by || 'System',
        title,
        body: `${cleanDesc} (on ${new Date(h.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })})`,
        campus_ids: [h.campus_id],
        class_ids: h.class_id ? [h.class_id] : [],
        section_ids: h.section_id ? [h.section_id] : [],
        student_ccs: [],
        student_statuses: [],
        academic_years: [],
        media_urls: [],
        media_types: [],
        is_pinned: isPinned,
        notification_only: false,
        posted_at: h.date,
        expires_at: null,
        deleted_at: null,
        users: { full_name: creatorName || h.created_by || 'System' },
        _count: { post_reads: 0 },
        total_reached: 0,
      };
    });

    const merged = [...postsWithReach, ...holidayPosts];
    merged.sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      return new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime();
    });

    return merged;
  }

  async createPost(postedBy: string, dto: CreatePostDto, creatorUsername?: string) {
    // Student targeting is exclusive in the feed — strip campus/class/section so
    // the stored post can't look school-/campus-scoped while only listing kids.
    const studentCcs = dto.student_ccs ?? [];
    const campusIds = studentCcs.length ? [] : (dto.campus_ids ?? []);
    const classIds = studentCcs.length ? [] : (dto.class_ids ?? []);
    const sectionIds = studentCcs.length ? [] : (dto.section_ids ?? []);
    const studentStatuses = studentCcs.length ? [] : ((dto.student_statuses ?? []) as student_status[]);
    const academicYears = studentCcs.length ? [] : (dto.academic_years ?? []);

    const post = await this.prisma.notice_board_posts.create({
      data: {
        posted_by: postedBy,
        title: dto.title,
        body: dto.body,
        campus_ids: campusIds,
        class_ids: classIds,
        section_ids: sectionIds,
        student_ccs: studentCcs,
        student_statuses: studentStatuses,
        academic_years: academicYears,
        media_urls: dto.media_urls ?? [],
        media_types: dto.media_types ?? [],
        is_pinned: dto.is_pinned ?? false,
        notification_only: dto.notification_only ?? false,
        expires_at: dto.expires_at ? new Date(dto.expires_at) : null,
      },
      include: {
        users: { select: { full_name: true } },
        _count: { select: { post_reads: true } },
      },
    });

    const noteParts = [
      `Posted "${dto.title?.trim() || 'untitled'}"`,
      this._audienceSummary(post),
      `Body: ${this._snippet(dto.body)}`,
    ];
    if (dto.is_pinned) noteParts.push('Pinned');
    if (dto.notification_only) noteParts.push('Notification only');

    await this.auditLogs.log({
      entity_type: 'NOTICE',
      entity_id: String(post.id),
      action: 'CREATED',
      section: 'communication',
      new_value: dto.title ?? this._snippet(dto.body, 80),
      note: noteParts.join(' | '),
      changed_by: creatorUsername || postedBy,
    });

    // Fire-and-forget push notifications to all scoped families
    this._sendPostNotifications(post).catch((err) =>
      console.error('Notice board FCM dispatch failed:', err.message),
    );

    return {
      ...post,
      total_reached: await this._countAudienceFamilies(post),
    };
  }

  private async _sendPostNotifications(post: {
    id: number;
    title: string | null;
    body: string;
    is_pinned?: boolean;
    campus_ids: unknown;
    class_ids: unknown;
    section_ids: unknown;
    student_ccs: unknown;
    student_statuses: unknown;
    academic_years: unknown;
  }) {
    const familyIds = await this._resolveAudienceFamilyIds(post);
    if (!familyIds.length) return;

    const title = post.title ?? 'New School Notice';
    const body =
      post.body.length > 120 ? post.body.slice(0, 117) + '…' : post.body;
    const data = { type: 'notice_board', post_id: String(post.id) };
    const socketPayload = {
      type: 'notice_board' as const,
      post_id: post.id,
      title,
      body,
      is_pinned: post.is_pinned ?? false,
    };

    await Promise.allSettled(
      familyIds.map(async (familyId) => {
        this.chatGateway.broadcastNoticeBoard(familyId, socketPayload);
        await this.fcm.sendToFamily(familyId, title, body, data);
      }),
    );
  }

  /**
   * Resolve which families should receive a notice push / socket event.
   * Must match getPostsForFamily visibility:
   * - student_ccs set → ONLY those students' families (exclusive)
   * - else campus/class/section → matching families
   * - else → school-wide
   */
  private async _resolveAudienceFamilyIds(post: {
    campus_ids: unknown;
    class_ids: unknown;
    section_ids: unknown;
    student_ccs: unknown;
    student_statuses: unknown;
    academic_years: unknown;
  }): Promise<number[]> {
    const campusIds = (post.campus_ids as number[]) ?? [];
    const classIds = (post.class_ids as number[]) ?? [];
    const sectionIds = (post.section_ids as number[]) ?? [];
    const studentCcs = (post.student_ccs as number[]) ?? [];
    const studentStatuses = (post.student_statuses as student_status[]) ?? [];
    const academicYears = (post.academic_years as string[]) ?? [];

    // Student targeting is exclusive — same as feed filtering.
    if (studentCcs.length) {
      const targetStudents = await this.prisma.students.findMany({
        where: {
          cc: { in: studentCcs },
          deleted_at: null,
          family_id: { not: null },
        },
        select: { family_id: true },
      });
      return [
        ...new Set(
          targetStudents
            .map((s) => s.family_id)
            .filter((id): id is number => id != null),
        ),
      ];
    }

    const hasScope =
      campusIds.length > 0 || classIds.length > 0 || sectionIds.length > 0 ||
      studentStatuses.length > 0 || academicYears.length > 0;

    if (hasScope) {
      const families = await this.prisma.families.findMany({
        where: {
          deleted_at: null,
          students: {
            some: {
              deleted_at: null,
              AND: [
                campusIds.length ? { campus_id: { in: campusIds } } : {},
                classIds.length ? { class_id: { in: classIds } } : {},
                sectionIds.length ? { section_id: { in: sectionIds } } : {},
                studentStatuses.length ? { status: { in: studentStatuses } } : {},
                academicYears.length ? { academic_year: { in: academicYears } } : {},
              ],
            },
          },
        },
        select: { id: true },
      });
      return families.map((f) => f.id);
    }

    // School-wide notice: no audience filters set.
    const families = await this.prisma.families.findMany({
      where: {
        deleted_at: null,
        students: { some: { deleted_at: null } },
      },
      select: { id: true },
    });
    return families.map((f) => f.id);
  }

  async updatePost(id: string | number, dto: UpdatePostDto, changedBy?: string) {
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

      if (h.description !== newDesc || dto.is_pinned !== undefined) {
        await this.auditLogs.log({
          entity_type: 'NOTICE',
          entity_id: `holiday-${holidayId}`,
          action: 'UPDATED',
          section: 'communication',
          changed_by: changedBy ?? 'system',
          note: `Holiday notice #${holidayId} updated` +
            (dto.is_pinned !== undefined ? `: is_pinned → ${dto.is_pinned}` : '') +
            (h.description !== newDesc ? `, description "${h.description ?? '—'}" → "${newDesc}"` : '') + '.',
        });
      }

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

    const updated = await this.prisma.notice_board_posts.update({
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

    const changes: string[] = [];
    if (dto.title !== undefined && post.title !== updated.title) {
      changes.push(`title "${post.title ?? '—'}" → "${updated.title ?? '—'}"`);
    }
    if (dto.body !== undefined && post.body !== updated.body) {
      changes.push(`body "${(post.body ?? '').slice(0, 60)}" → "${(updated.body ?? '').slice(0, 60)}"`);
    }
    if (dto.is_pinned !== undefined && post.is_pinned !== updated.is_pinned) {
      changes.push(`is_pinned ${post.is_pinned} → ${updated.is_pinned}`);
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
        entity_type: 'NOTICE',
        entity_id: String(numericId),
        action: 'UPDATED',
        section: 'communication',
        changed_by: changedBy ?? 'system',
        note: `Notice #${numericId} ("${post.title ?? 'untitled'}") updated: ${changes.join(', ')}.`,
      });
    }

    return updated;
  }

  async deletePost(id: string | number, deletedBy?: string) {
    if (String(id).startsWith('holiday-')) {
      const holidayId = parseInt(String(id).replace('holiday-', ''), 10);
      const deleted = await this.prisma.academic_calendar_days.delete({
        where: { id: holidayId },
      });

      // Delete the generated calendar notifications for this holiday from the mobile app feed
      await this.prisma.calendar_notifications.deleteMany({
        where: {
          date: deleted.date,
          alert_type: deleted.day_type === 'WORKDAY' ? 'SCHOOL_OPEN' : 'HOLIDAY',
          students: {
            campus_id: deleted.campus_id,
            ...(deleted.class_id ? { class_id: deleted.class_id } : {}),
            ...(deleted.section_id ? { section_id: deleted.section_id } : {}),
          },
        },
      });

      await this.auditLogs.log({
        entity_type: 'NOTICE',
        entity_id: `holiday-${holidayId}`,
        action: 'DELETED',
        section: 'communication',
        old_value: deleted.description ?? deleted.day_type,
        note: `Deleted holiday notice "${deleted.description || deleted.day_type}" (${deleted.date.toISOString().slice(0, 10)}).`,
        changed_by: deletedBy ?? 'system',
      });

      return { id: `holiday-${deleted.id}` };
    }

    const numericId = typeof id === 'number' ? id : parseInt(id, 10);
    const post = await this.prisma.notice_board_posts.findFirst({
      where: { id: numericId, deleted_at: null },
    });
    if (!post) throw new NotFoundException('Post not found');

    const result = await this.prisma.notice_board_posts.update({
      where: { id: numericId },
      data: { deleted_at: new Date() },
    });
    await this.auditLogs.log({
      entity_type: 'NOTICE',
      entity_id: String(numericId),
      action: 'DELETED',
      section: 'communication',
      old_value: post.title ?? this._snippet(post.body, 80),
      note: [
        `Deleted "${post.title?.trim() || 'untitled'}"`,
        this._audienceSummary(post),
        `Body: ${this._snippet(post.body)}`,
      ].join(' | '),
      changed_by: deletedBy ?? 'system',
    });
    return result;
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
    if (isNaN(numericId)) {
      return {
        post_id: postId,
        total_reached: 0,
        total_read: 0,
      };
    }
    const post = await this.prisma.notice_board_posts.findFirst({
      where: { id: numericId, deleted_at: null },
      select: {
        campus_ids: true,
        class_ids: true,
        section_ids: true,
        student_ccs: true,
        student_statuses: true,
        academic_years: true,
        _count: { select: { post_reads: true } },
      },
    });
    if (!post) throw new NotFoundException('Post not found');

    const reachedCount = await this._countAudienceFamilies(post);
    const studentCcs = post.student_ccs as number[];
    let targetedReads: any[] = [];

    if (studentCcs && studentCcs.length) {
      // Query targeted student read statuses
      const studentsInScope = await this.prisma.students.findMany({
        where: { cc: { in: studentCcs } },
        select: {
          cc: true,
          full_name: true,
          gr_number: true,
          family_id: true,
          families: {
            select: {
              household_name: true,
              notice_post_reads: {
                where: { post_id: numericId },
                select: { read_at: true },
              },
            },
          },
        },
      });

      targetedReads = studentsInScope.map((s) => ({
        cc: s.cc,
        full_name: s.full_name,
        gr_number: s.gr_number,
        household_name: s.families?.household_name || null,
        read_at: s.families?.notice_post_reads?.[0]?.read_at || null,
      }));
    }

    return {
      post_id: numericId,
      total_reached: reachedCount,
      total_read: post._count.post_reads,
      targeted_reads: targetedReads.length ? targetedReads : undefined,
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

  // ── Audience / log helpers ────────────────────────────────────────────────

  private _snippet(text: string | null | undefined, max = 120): string {
    const value = (text ?? '').replace(/\s+/g, ' ').trim();
    if (!value) return '—';
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  }

  private _isSchoolWide(post: {
    campus_ids: unknown;
    class_ids: unknown;
    section_ids: unknown;
    student_ccs: unknown;
    student_statuses: unknown;
    academic_years: unknown;
  }): boolean {
    const campusIds = (post.campus_ids as number[]) ?? [];
    const classIds = (post.class_ids as number[]) ?? [];
    const sectionIds = (post.section_ids as number[]) ?? [];
    const studentCcs = (post.student_ccs as number[]) ?? [];
    const studentStatuses = (post.student_statuses as student_status[]) ?? [];
    const academicYears = (post.academic_years as string[]) ?? [];
    return (
      studentCcs.length === 0 &&
      campusIds.length === 0 &&
      classIds.length === 0 &&
      sectionIds.length === 0 &&
      studentStatuses.length === 0 &&
      academicYears.length === 0
    );
  }

  private _audienceSummary(post: {
    campus_ids: unknown;
    class_ids: unknown;
    section_ids: unknown;
    student_ccs: unknown;
    student_statuses: unknown;
    academic_years: unknown;
  }): string {
    const studentCcs = (post.student_ccs as number[]) ?? [];
    if (studentCcs.length) {
      return `${studentCcs.length} student${studentCcs.length === 1 ? '' : 's'} targeted`;
    }
    if (this._isSchoolWide(post)) return 'school-wide';
    const parts: string[] = [];
    const campusIds = (post.campus_ids as number[]) ?? [];
    const classIds = (post.class_ids as number[]) ?? [];
    const sectionIds = (post.section_ids as number[]) ?? [];
    const studentStatuses = (post.student_statuses as student_status[]) ?? [];
    const academicYears = (post.academic_years as string[]) ?? [];
    if (campusIds.length) parts.push(`${campusIds.length} campus${campusIds.length === 1 ? '' : 'es'}`);
    if (classIds.length) parts.push(`${classIds.length} class${classIds.length === 1 ? '' : 'es'}`);
    if (sectionIds.length) parts.push(`${sectionIds.length} section${sectionIds.length === 1 ? '' : 's'}`);
    if (studentStatuses.length) parts.push(`status ${studentStatuses.join(', ')}`);
    if (academicYears.length) parts.push(academicYears.join(', '));
    return parts.join(', ') || 'targeted';
  }

  private async _countAudienceFamilies(post: {
    campus_ids: unknown;
    class_ids: unknown;
    section_ids: unknown;
    student_ccs: unknown;
    student_statuses: unknown;
    academic_years: unknown;
  }): Promise<number> {
    const studentCcs = (post.student_ccs as number[]) ?? [];
    if (studentCcs.length) {
      const students = await this.prisma.students.findMany({
        where: {
          cc: { in: studentCcs },
          deleted_at: null,
          family_id: { not: null },
        },
        select: { family_id: true },
      });
      return new Set(
        students
          .map((s) => s.family_id)
          .filter((id): id is number => id != null),
      ).size;
    }

    const campusIds = (post.campus_ids as number[]) ?? [];
    const classIds = (post.class_ids as number[]) ?? [];
    const sectionIds = (post.section_ids as number[]) ?? [];
    const studentStatuses = (post.student_statuses as student_status[]) ?? [];
    const academicYears = (post.academic_years as string[]) ?? [];

    return this.prisma.families.count({
      where: {
        deleted_at: null,
        students: {
          some: {
            deleted_at: null,
            AND: [
              campusIds.length ? { campus_id: { in: campusIds } } : {},
              classIds.length ? { class_id: { in: classIds } } : {},
              sectionIds.length ? { section_id: { in: sectionIds } } : {},
              studentStatuses.length ? { status: { in: studentStatuses } } : {},
              academicYears.length ? { academic_year: { in: academicYears } } : {},
            ],
          },
        },
      },
    });
  }
}
