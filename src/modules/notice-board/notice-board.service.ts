import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { NoticePostStatus, StaffRole, student_status } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { ScopeService } from '../../common/scope/scope.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ChatGateway } from '../chat/chat.gateway';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import * as path from 'path';

const POST_LIST_INCLUDE = {
  users: { select: { full_name: true } },
  reviewer: { select: { full_name: true } },
  _count: { select: { post_reads: true } },
} as const;

/** Audit field whose old/new values hold a notice's full title and body as JSON. */
const NOTICE_WORDING_FIELD = 'Wording';

type PostListRow = {
  student_ccs: number[];
  campus_ids: number[];
  class_ids: number[];
  section_ids: number[];
  student_statuses: student_status[];
  academic_years: string[];
};

const REVIEW_STATUSES: NoticePostStatus[] = [
  NoticePostStatus.PENDING,
  NoticePostStatus.APPROVED,
  NoticePostStatus.REJECTED,
];

@Injectable()
export class NoticeBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly fcm: FcmService,
    private readonly auditLogs: AuditLogsService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
    private readonly scope: ScopeService,
  ) {}

  /**
   * A scoped poster may only address families inside their own scope, and may
   * never leave a restricted dimension empty — empty targeting means "the
   * whole school" (see getPostsForFamily's isEmpty-OR clauses), which would
   * let a campus-scoped user broadcast to every family. Specific student_ccs
   * are checked one by one instead, since they bypass the campus/class/
   * section lists entirely.
   */
  private async assertTargetingInScope(
    user: IJwtStaffPayload,
    t: { campus_ids?: number[]; class_ids?: number[]; section_ids?: number[]; student_ccs?: number[] },
  ): Promise<void> {
    if (this.scope.isExempt(user)) return;
    const s = this.scope.scopeOf(user);
    const restricted = s.campuses.length + s.classes.length + s.sections.length + s.segments.length > 0;
    if (!restricted) return;

    const ccs = t.student_ccs ?? [];
    if (ccs.length > 0) {
      const rows = await this.prisma.students.findMany({
        where: { cc: { in: ccs } },
        select: { cc: true, campus_id: true, class_id: true, section_id: true, classes: { select: { segment_id: true } } },
      });
      const byCc = new Map(rows.map((r) => [r.cc, r]));
      const outside = ccs.filter((cc) => {
        const r = byCc.get(cc);
        return !r || !this.scope.canSeeStudent(user, {
          campus_id: r.campus_id, class_id: r.class_id, section_id: r.section_id,
          segment_id: r.classes?.segment_id ?? null,
        });
      });
      if (outside.length > 0) {
        throw new ForbiddenException(`Outside your scope: student CC ${outside.join(', ')}.`);
      }
      return;
    }

    const c = t.campus_ids ?? [];
    const cl = t.class_ids ?? [];
    const se = t.section_ids ?? [];
    const leaves = (restrictedDim: boolean, list: number[]) => restrictedDim && list.length === 0;
    if (
      leaves(s.campuses.length > 0, c) ||
      leaves(s.classes.length > 0, cl) ||
      leaves(s.sections.length > 0, se) ||
      (s.segments.length > 0 && c.length + cl.length + se.length === 0)
    ) {
      throw new ForbiddenException('Only an unrestricted admin may post without targeting — it would reach families outside your scope.');
    }
    c.forEach((id) => this.scope.assertCampus(user, id));
    cl.forEach((id) => this.scope.assertClass(user, id));
    se.forEach((id) => this.scope.assertSection(user, id));
  }

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
        status: NoticePostStatus.APPROVED,
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

  // The feed shows live posts plus the caller's own pending / rejected ones
  // (badged in the UI). Other people's pending posts live on the review page
  // only — superadmins included.
  async getAllPosts(cursor: number | undefined, user: IJwtStaffPayload) {
    // A scoped caller sees posts that reached at least one of their students,
    // plus their own. Most posts reach one campus or one family, so batches are
    // read until a full page is visible (bounded, so a narrow scope can't scan
    // the whole table).
    const reach = await this._scopeReach(user);
    const PAGE = 30;
    const BATCH = reach ? 150 : PAGE;
    const fetchedPosts: Awaited<ReturnType<typeof this._postBatch>> = [];
    for (let skip = 0; fetchedPosts.length < PAGE && skip < BATCH * 8; skip += BATCH) {
      const batch = await this._postBatch(cursor, user, skip, BATCH);
      fetchedPosts.push(...(reach ? batch.filter((p) => reach.reaches(p)) : batch));
      if (batch.length < BATCH) break;
    }
    const posts: ((typeof fetchedPosts)[number] & { viewer_can_manage: boolean })[] = [];
    for (const p of fetchedPosts.slice(0, PAGE)) {
      posts.push({ ...p, viewer_can_manage: !reach || (await this._canManagePost(user, p)) });
    }

    const withTargets = await this._withTargetsAndReach(posts);
    // A post seen through overlap must not list targeted students outside the caller's scope.
    const postsWithReach = reach
      ? withTargets.map((p) => ({ ...p, targeted_students: p.targeted_students.filter((t) => reach.seesStudent(t!.cc)) }))
      : withTargets;

    const allHolidays = await this.prisma.academic_calendar_days.findMany({
      where: {
        applies_to: 'STUDENT',
        day_type: { in: ['HOLIDAY', 'WORKDAY'] },
      },
      orderBy: { date: 'desc' },
      take: 30,
    });
    // Same rule as posts: a scoped caller sees holiday notices that reached at
    // least one of their students.
    const holidays: (typeof allHolidays[number] & { viewer_can_manage: boolean })[] = [];
    for (const h of allHolidays) {
      const audience = { posted_by: h.created_by, ...this._holidayAudience(h), student_ccs: [] };
      if (reach && !reach.reaches(audience)) continue;
      holidays.push({ ...h, viewer_can_manage: !reach || (await this._canManagePost(user, audience)) });
    }

    const userIds = holidays.map((h) => h.created_by).filter((cb): cb is string => !!cb);
    const creators = userIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: userIds } },
          select: { id: true, full_name: true },
        })
      : [];
    const creatorMap = new Map(creators.map((u) => [u.id, u.full_name]));
    const holidayReadCounts = await this._holidayReadCounts(holidays);
    const holidayReachCache = new Map<string, number>();
    const uniqueHolidayScopes = new Map<string, (typeof holidays)[number]>();
    for (const h of holidays) {
      const key = `${h.campus_id}:${h.class_id ?? ''}:${h.section_id ?? ''}`;
      if (!uniqueHolidayScopes.has(key)) uniqueHolidayScopes.set(key, h);
    }
    await Promise.all(
      [...uniqueHolidayScopes.entries()].map(async ([key, h]) => {
        holidayReachCache.set(key, await this._countAudienceFamilies(this._holidayAudience(h)));
      }),
    );

    const holidayPosts = holidays.map((h) => {
      const isPinned = h.description?.startsWith('[PINNED] ') ?? false;
      const defaultDesc = h.day_type === 'WORKDAY' ? 'School Open' : 'Holiday';
      const cleanDesc = isPinned ? h.description!.replace('[PINNED] ', '') : (h.description || defaultDesc);
      const creatorName = h.created_by ? creatorMap.get(h.created_by) : null;
      const title = h.day_type === 'WORKDAY' ? 'School Open' : 'School Closed';
      const reachKey = `${h.campus_id}:${h.class_id ?? ''}:${h.section_id ?? ''}`;
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
        status: NoticePostStatus.APPROVED,
        posted_at: h.date,
        expires_at: null,
        deleted_at: null,
        users: { full_name: creatorName || h.created_by || 'System' },
        _count: { post_reads: holidayReadCounts.get(h.id) ?? 0 },
        total_reached: holidayReachCache.get(reachKey) ?? 0,
        viewer_can_manage: h.viewer_can_manage,
      };
    });

    const merged = [...postsWithReach, ...holidayPosts];
    merged.sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      return new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime();
    });

    return merged;
  }

  private _postBatch(cursor: number | undefined, user: IJwtStaffPayload, skip: number, take: number) {
    return this.prisma.notice_board_posts.findMany({
      where: {
        deleted_at: null,
        OR: [{ status: NoticePostStatus.APPROVED }, { posted_by: user.sub }],
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: [{ is_pinned: 'desc' }, { posted_at: 'desc' }],
      include: POST_LIST_INCLUDE,
      skip,
      take,
    });
  }

  /**
   * TAFSD-315: which posts belong on a scoped caller's board — those that
   * reached at least one student in their scope (an all-campus notice their
   * parents got too), plus their own. null means the caller sees everything
   * (superadmin, or no scope set). Editing, deleting and read stats still
   * need the whole audience in scope (assertCanManagePost).
   */
  private async _scopeReach(user: IJwtStaffPayload) {
    if (this.scope.isExempt(user)) return null;
    const inScope = this.scope.whereForStudents(user);
    if (Object.keys(inScope).length === 0) return null;

    const students = await this.prisma.students.findMany({
      where: { deleted_at: null, ...inScope },
      select: { cc: true, campus_id: true, class_id: true, section_id: true },
    });
    const ccs = new Set(students.map((st) => st.cc));
    const placements = [
      ...new Map(students.map((st) => [`${st.campus_id}:${st.class_id}:${st.section_id}`, st])).values(),
    ];
    const hits = (list: number[], id: number | null) => list.length === 0 || (id != null && list.includes(id));

    return {
      seesStudent: (cc: number) => ccs.has(cc),
      reaches: (post: {
        posted_by: string | null;
        campus_ids: unknown;
        class_ids: unknown;
        section_ids: unknown;
        student_ccs: unknown;
      }) => {
        if (post.posted_by === user.sub) return true;
        // Student targeting is exclusive, as in _resolveAudienceFamilyIds.
        const targeted = (post.student_ccs as number[]) ?? [];
        if (targeted.length) return targeted.some((cc) => ccs.has(cc));
        const campusIds = (post.campus_ids as number[]) ?? [];
        const classIds = (post.class_ids as number[]) ?? [];
        const sectionIds = (post.section_ids as number[]) ?? [];
        return placements.some(
          (pl) => hits(campusIds, pl.campus_id) && hits(classIds, pl.class_id) && hits(sectionIds, pl.section_id),
        );
      },
    };
  }

  private async _canManagePost(
    user: IJwtStaffPayload,
    post: { campus_ids: unknown; class_ids: unknown; section_ids: unknown; student_ccs: unknown },
  ): Promise<boolean> {
    try {
      await this.assertCanManagePost(user, post);
      return true;
    } catch {
      return false;
    }
  }

  /** Adds targeted_students and total_reached to each post, for the admin views. */
  private async _withTargetsAndReach<T extends PostListRow>(posts: T[]) {
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

    return postsWithReach;
  }

  // `user` is omitted by in-process callers that post a system notice on
  // someone's behalf (e.g. ParentChangeRequestsService) — only the admin HTTP
  // route threads a caller through, so only it is scope-checked here, and
  // only it can land in review: a post by anyone but a SUPER_ADMIN is held as
  // PENDING, with no push, until a superadmin approves it (approvePost).
  /**
   * `skipReview` is for system-worded notices (e.g. TAFSD-384's defaulter
   * notice, whose copy is fixed on Notification Templates): they post
   * APPROVED straight away. Targeting scope is still enforced.
   */
  async createPost(
    postedBy: string,
    dto: CreatePostDto,
    creatorUsername?: string,
    user?: IJwtStaffPayload,
    options: { skipReview?: boolean } = {},
  ) {
    if (user) await this.assertTargetingInScope(user, dto);
    const needsReview = !!user && !options.skipReview && !this.isSuperAdmin(user);
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
        status: needsReview ? NoticePostStatus.PENDING : NoticePostStatus.APPROVED,
      },
      include: POST_LIST_INCLUDE,
    });

    const noteParts = [
      `${needsReview ? 'Submitted for approval' : 'Posted'} "${dto.title?.trim() || 'untitled'}"`,
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
    if (!needsReview) {
      this._sendPostNotifications(post).catch((err) =>
        console.error('Notice board FCM dispatch failed:', err.message),
      );
    }

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

  /**
   * A scoped caller may only edit/delete/inspect a post whose stored audience
   * is inside their own scope — 404, never 403, so this can't be used to
   * enumerate posts aimed at other campuses.
   */
  private async assertCanManagePost(
    user: IJwtStaffPayload,
    post: { campus_ids: unknown; class_ids: unknown; section_ids: unknown; student_ccs: unknown },
  ): Promise<void> {
    try {
      await this.assertTargetingInScope(user, {
        campus_ids: post.campus_ids as number[],
        class_ids: post.class_ids as number[],
        section_ids: post.section_ids as number[],
        student_ccs: post.student_ccs as number[],
      });
    } catch {
      throw new NotFoundException('Post not found');
    }
  }

  /** Holiday notices carry their own campus/class/section — same 404 rule. */
  private async assertCanManageHoliday(user: IJwtStaffPayload, holidayId: number): Promise<void> {
    if (this.scope.isExempt(user)) return;
    const h = await this.prisma.academic_calendar_days.findUnique({
      where: { id: holidayId },
      select: { campus_id: true, class_id: true, section_id: true },
    });
    try {
      if (!h) throw new Error('missing');
      this.scope.assertCampus(user, h.campus_id);
      if (h.class_id != null) this.scope.assertClass(user, h.class_id);
      if (h.section_id != null) this.scope.assertSection(user, h.section_id);
    } catch {
      throw new NotFoundException('Holiday not found');
    }
  }

  async updatePost(id: string | number, dto: UpdatePostDto, changedBy: string | undefined, user: IJwtStaffPayload) {
    if (String(id).startsWith('holiday-')) {
      const holidayId = parseInt(String(id).replace('holiday-', ''), 10);
      await this.assertCanManageHoliday(user, holidayId);
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
    await this.assertCanManagePost(user, post);

    // New wording from a non-superadmin is a new submission: it goes back to
    // PENDING (an approved post leaves families' feeds until re-approved, a
    // rejected one is resubmitted). Pin / expiry changes alone don't.
    // TAFSD-405: attachments are replaced as a list, urls and types in step.
    if ((dto.media_urls === undefined) !== (dto.media_types === undefined)) {
      throw new BadRequestException('Send media_urls and media_types together');
    }
    if (dto.media_urls && dto.media_types && dto.media_urls.length !== dto.media_types.length) {
      throw new BadRequestException('media_urls and media_types must be the same length');
    }
    const oldMedia = (post.media_urls as string[] | null) ?? [];
    const mediaChanged =
      dto.media_urls !== undefined && JSON.stringify(dto.media_urls) !== JSON.stringify(oldMedia);

    const contentChanged =
      (dto.title !== undefined && dto.title !== post.title) ||
      (dto.body !== undefined && dto.body !== post.body) ||
      mediaChanged;
    const backToReview =
      contentChanged && !this.isSuperAdmin(user) && post.status !== NoticePostStatus.PENDING;

    const updated = await this.prisma.notice_board_posts.update({
      where: { id: numericId },
      data: {
        ...(backToReview && {
          status: NoticePostStatus.PENDING,
          reviewed_by: null,
          reviewed_at: null,
          review_reason: null,
        }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(mediaChanged && { media_urls: dto.media_urls, media_types: dto.media_types }),
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
    if (mediaChanged) {
      const next = dto.media_urls ?? [];
      const added = next.filter((u) => !oldMedia.includes(u)).length;
      const removed = oldMedia.filter((u) => !next.includes(u)).length;
      changes.push(`attachments ${oldMedia.length} → ${next.length} (${added} added, ${removed} removed)`);
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
    if (backToReview) changes.push(`status ${post.status} → PENDING (resubmitted for approval)`);

    // TAFSD-416: the full wording before and after, so the author can see
    // exactly what was changed (the note only carries a snippet).
    const wordingChanged = post.title !== updated.title || post.body !== updated.body;
    if (changes.length > 0) {
      await this.auditLogs.log({
        entity_type: 'NOTICE',
        entity_id: String(numericId),
        action: 'UPDATED',
        section: 'communication',
        changed_by: changedBy ?? 'system',
        ...(wordingChanged && {
          field: NOTICE_WORDING_FIELD,
          old_value: JSON.stringify({ title: post.title, body: post.body }),
          new_value: JSON.stringify({ title: updated.title, body: updated.body }),
        }),
        note: `Notice #${numericId} ("${post.title ?? 'untitled'}") updated: ${changes.join(', ')}.`,
      });
    }
    if (contentChanged && post.posted_by !== user.sub) {
      this._notifyAuthor(
        updated,
        'Notice edited',
        `"${updated.title?.trim() || this._snippet(updated.body, 60)}" was edited by ${changedBy ?? 'an admin'}.`,
      );
    }

    return updated;
  }

  /**
   * TAFSD-404: the poster may edit or delete their own notice while it is
   * still PENDING approval (or was REJECTED) — no family has seen it yet —
   * with only the "post a notice" permission. Approved notices need the
   * edit / delete permissions as before. Pinning stays an edit permission.
   */
  private async assertOwnUnapprovedPost(id: string | number, user: IJwtStaffPayload) {
    const numericId = typeof id === 'number' ? id : parseInt(String(id), 10);
    if (!Number.isFinite(numericId)) throw new NotFoundException('Post not found');
    const post = await this.prisma.notice_board_posts.findFirst({
      where: { id: numericId, deleted_at: null },
      select: { id: true, posted_by: true, status: true },
    });
    if (!post || post.posted_by !== user.sub) throw new NotFoundException('Post not found');
    if (post.status === NoticePostStatus.APPROVED) {
      throw new BadRequestException(
        'This notice has already been approved. Ask someone with edit or delete access on the notice board to change it.',
      );
    }
    return numericId;
  }

  async updateOwnPost(id: string | number, dto: UpdatePostDto, changedBy: string | undefined, user: IJwtStaffPayload) {
    const numericId = await this.assertOwnUnapprovedPost(id, user);
    const { is_pinned: _pin, ...content } = dto;
    return this.updatePost(numericId, content, changedBy, user);
  }

  async deleteOwnPost(id: string | number, deletedBy: string | undefined, user: IJwtStaffPayload) {
    const numericId = await this.assertOwnUnapprovedPost(id, user);
    return this.deletePost(numericId, deletedBy, user);
  }

  async deletePost(id: string | number, deletedBy: string | undefined, user: IJwtStaffPayload) {
    if (String(id).startsWith('holiday-')) {
      const holidayId = parseInt(String(id).replace('holiday-', ''), 10);
      await this.assertCanManageHoliday(user, holidayId);
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
    await this.assertCanManagePost(user, post);

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

  async getReadStats(postId: string | number, user: IJwtStaffPayload) {
    if (String(postId).startsWith('holiday-')) {
      const holidayId = parseInt(String(postId).replace('holiday-', ''), 10);
      const holiday = await this.prisma.academic_calendar_days.findUnique({
        where: { id: holidayId },
      });
      if (!holiday) throw new NotFoundException('Holiday not found');
      await this.assertCanManageHoliday(user, holidayId);

      const [total_reached, total_read] = await Promise.all([
        this._countAudienceFamilies(this._holidayAudience(holiday)),
        this._countHolidayFamilyReads(holiday),
      ]);
      return { post_id: postId, total_reached, total_read };
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
    await this.assertCanManagePost(user, post);

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

  // ── Review (SUPER_ADMIN only) ────────────────────────────────────────────

  private isSuperAdmin(user: IJwtStaffPayload): boolean {
    return user.role === StaffRole.SUPER_ADMIN;
  }

  private assertReviewer(user: IJwtStaffPayload): void {
    if (!this.isSuperAdmin(user)) {
      throw new ForbiddenException('Only a superadmin can review notice board posts.');
    }
  }

  async getReviewQueue(
    status: string | undefined,
    cursor: number | undefined,
    user: IJwtStaffPayload,
    q?: string,
  ) {
    this.assertReviewer(user);
    const wanted = (status ?? NoticePostStatus.PENDING).toUpperCase() as NoticePostStatus;
    if (!REVIEW_STATUSES.includes(wanted)) {
      throw new BadRequestException(`status must be one of ${REVIEW_STATUSES.join(', ')}`);
    }
    // Pending is a queue (oldest first). The decided lists are history: only
    // posts that went through review, newest decision first.
    const posts = await this.prisma.notice_board_posts.findMany({
      where: {
        deleted_at: null,
        status: wanted,
        ...(wanted === NoticePostStatus.PENDING ? {} : { reviewed_at: { not: null } }),
        ...(q?.trim()
          ? {
              OR: [
                { title: { contains: q.trim(), mode: 'insensitive' as const } },
                { body: { contains: q.trim(), mode: 'insensitive' as const } },
                { users: { full_name: { contains: q.trim(), mode: 'insensitive' as const } } },
              ],
            }
          : {}),
      },
      orderBy:
        wanted === NoticePostStatus.PENDING
          ? [{ id: 'asc' }]
          : [{ reviewed_at: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: POST_LIST_INCLUDE,
      take: 30,
    });
    return this._withTargetsAndReach(posts);
  }

  async getPendingCount(user: IJwtStaffPayload) {
    this.assertReviewer(user);
    const pending = await this.prisma.notice_board_posts.count({
      where: { deleted_at: null, status: NoticePostStatus.PENDING },
    });
    return { pending };
  }

  async approvePost(id: number, user: IJwtStaffPayload, changedBy: string | undefined) {
    this.assertReviewer(user);
    const post = await this._decide(id, user, NoticePostStatus.APPROVED, null);

    // Goes live now: dated at approval so it lands at the top of the feed,
    // and families are notified only at this point.
    this._sendPostNotifications(post).catch((err) =>
      console.error('Notice board FCM dispatch failed:', err.message),
    );
    this._notifyAuthor(post, 'Notice approved', `"${post.title?.trim() || this._snippet(post.body, 60)}" is now live.`);

    await this.auditLogs.log({
      entity_type: 'NOTICE',
      entity_id: String(id),
      action: 'APPROVED',
      section: 'communication',
      new_value: post.title ?? this._snippet(post.body, 80),
      note: `Approved notice #${id} by ${post.users?.full_name ?? post.posted_by} | ${this._audienceSummary(post)}`,
      changed_by: changedBy ?? user.sub,
    });
    return { ...post, total_reached: await this._countAudienceFamilies(post) };
  }

  async rejectPost(id: number, reason: string, user: IJwtStaffPayload, changedBy: string | undefined) {
    this.assertReviewer(user);
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('A reason is required to reject a post.');
    const post = await this._decide(id, user, NoticePostStatus.REJECTED, trimmed);

    this._notifyAuthor(post, 'Notice not approved', `"${post.title?.trim() || this._snippet(post.body, 60)}": ${trimmed}`);

    await this.auditLogs.log({
      entity_type: 'NOTICE',
      entity_id: String(id),
      action: 'REJECTED',
      section: 'communication',
      new_value: trimmed,
      note: `Rejected notice #${id} by ${post.users?.full_name ?? post.posted_by}. Reason: ${trimmed}`,
      changed_by: changedBy ?? user.sub,
    });
    return post;
  }

  /**
   * TAFSD-416: what happened to a notice — submitted, edited (full wording
   * before and after), approved, rejected with the reason — for its author
   * as well as whoever can manage it. Authors usually can't open the
   * activity logs, so it is served here.
   */
  async getPostHistory(id: number, user: IJwtStaffPayload) {
    const post = await this.prisma.notice_board_posts.findFirst({
      where: { id, deleted_at: null },
      include: POST_LIST_INCLUDE,
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.posted_by !== user.sub) await this.assertCanManagePost(user, post);

    const logs = await this.prisma.audit_logs.findMany({
      where: { entity_type: 'NOTICE', entity_id: String(id) },
      orderBy: { changed_at: 'asc' },
      select: { id: true, action: true, field: true, old_value: true, new_value: true, changed_by: true, changed_at: true, note: true },
    });
    const wording = (v: string | null) => {
      try {
        const o = JSON.parse(v ?? '');
        return { title: (o.title as string | null) ?? null, body: (o.body as string | null) ?? '' };
      } catch {
        return null;
      }
    };
    return {
      id: post.id,
      status: post.status,
      posted_by: post.users?.full_name ?? null,
      review_reason: post.review_reason,
      reviewed_by: post.reviewer?.full_name ?? null,
      reviewed_at: post.reviewed_at,
      events: logs.map((l) => ({
        id: l.id,
        action: l.action,
        by: l.changed_by,
        at: l.changed_at,
        reason: l.action === 'REJECTED' ? l.new_value : null,
        before: l.field === NOTICE_WORDING_FIELD ? wording(l.old_value) : null,
        after: l.field === NOTICE_WORDING_FIELD ? wording(l.new_value) : null,
        note: l.note,
      })),
    };
  }

  /** PENDING → decision, atomically, so two reviewers can't both act on one post. */
  private async _decide(id: number, user: IJwtStaffPayload, status: NoticePostStatus, reason: string | null) {
    const now = new Date();
    const { count } = await this.prisma.notice_board_posts.updateMany({
      where: { id, deleted_at: null, status: NoticePostStatus.PENDING },
      data: {
        status,
        reviewed_by: user.sub,
        reviewed_at: now,
        review_reason: reason,
        ...(status === NoticePostStatus.APPROVED && { posted_at: now }),
      },
    });
    if (count === 0) {
      const exists = await this.prisma.notice_board_posts.findFirst({
        where: { id, deleted_at: null },
        select: { status: true },
      });
      if (!exists) throw new NotFoundException('Post not found');
      throw new ConflictException(`This post is already ${exists.status.toLowerCase()}.`);
    }
    return this.prisma.notice_board_posts.findUniqueOrThrow({
      where: { id },
      include: POST_LIST_INCLUDE,
    });
  }

  private _notifyAuthor(post: { id: number; posted_by: string }, title: string, body: string) {
    this.fcm
      .sendToUsers([post.posted_by], title, body, { type: 'notice_board_review', post_id: String(post.id) })
      .catch((err) => console.error('Notice review push failed:', err.message));
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

  private _holidayAlertType(dayType: string): 'HOLIDAY' | 'SCHOOL_OPEN' {
    return dayType === 'WORKDAY' ? 'SCHOOL_OPEN' : 'HOLIDAY';
  }

  private _holidayAudience(h: {
    campus_id: number;
    class_id: number | null;
    section_id: number | null;
  }) {
    return {
      campus_ids: [h.campus_id],
      class_ids: h.class_id ? [h.class_id] : [],
      section_ids: h.section_id ? [h.section_id] : [],
      student_ccs: [],
      student_statuses: [student_status.ENROLLED],
      academic_years: [],
    };
  }

  private _sameCalendarDate(a: Date, b: Date): boolean {
    return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
  }

  private async _countHolidayFamilyReads(h: {
    date: Date;
    campus_id: number;
    class_id: number | null;
    section_id: number | null;
    day_type: string;
  }): Promise<number> {
    const rows = await this.prisma.calendar_notifications.findMany({
      where: {
        date: h.date,
        alert_type: this._holidayAlertType(h.day_type),
        read_at: { not: null },
        students: {
          campus_id: h.campus_id,
          ...(h.class_id ? { class_id: h.class_id } : {}),
          ...(h.section_id ? { section_id: h.section_id } : {}),
        },
      },
      distinct: ['family_id'],
      select: { family_id: true },
    });
    return rows.length;
  }

  private async _holidayReadCounts(
    holidays: {
      id: number;
      date: Date;
      campus_id: number;
      class_id: number | null;
      section_id: number | null;
      day_type: string;
    }[],
  ): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    if (!holidays.length) return counts;

    const rows = await this.prisma.calendar_notifications.findMany({
      where: {
        date: { in: holidays.map((h) => h.date) },
        alert_type: { in: ['HOLIDAY', 'SCHOOL_OPEN'] },
        read_at: { not: null },
        students: {
          campus_id: { in: [...new Set(holidays.map((h) => h.campus_id))] },
        },
      },
      select: {
        family_id: true,
        date: true,
        alert_type: true,
        students: { select: { campus_id: true, class_id: true, section_id: true } },
      },
    });

    for (const h of holidays) {
      const alertType = this._holidayAlertType(h.day_type);
      const families = new Set<number>();
      for (const row of rows) {
        if (row.alert_type !== alertType) continue;
        if (!this._sameCalendarDate(row.date, h.date)) continue;
        if (row.students.campus_id !== h.campus_id) continue;
        if (h.class_id != null && row.students.class_id !== h.class_id) continue;
        if (h.section_id != null && row.students.section_id !== h.section_id) continue;
        families.add(row.family_id);
      }
      counts.set(h.id, families.size);
    }
    return counts;
  }

  private audienceCountCache = new Map<string, { value: number; expires: number }>();

  private _audienceKey(post: {
    campus_ids: unknown;
    class_ids: unknown;
    section_ids: unknown;
    student_ccs: unknown;
    student_statuses: unknown;
    academic_years: unknown;
  }): string {
    const ccs = ((post.student_ccs as number[]) ?? []).slice().sort().join(',');
    if (ccs) return `ccs:${ccs}`;
    const cmp = ((post.campus_ids as number[]) ?? []).slice().sort().join(',');
    const cls = ((post.class_ids as number[]) ?? []).slice().sort().join(',');
    const sec = ((post.section_ids as number[]) ?? []).slice().sort().join(',');
    const st = ((post.student_statuses as string[]) ?? []).slice().sort().join(',');
    const ay = ((post.academic_years as string[]) ?? []).slice().sort().join(',');
    return `${cmp}|${cls}|${sec}|${st}|${ay}`;
  }

  private async _countAudienceFamilies(post: {
    campus_ids: unknown;
    class_ids: unknown;
    section_ids: unknown;
    student_ccs: unknown;
    student_statuses: unknown;
    academic_years: unknown;
  }): Promise<number> {
    const cacheKey = this._audienceKey(post);
    const hit = this.audienceCountCache.get(cacheKey);
    const now = Date.now();
    if (hit && hit.expires > now) {
      return hit.value;
    }

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
      const count = new Set(
        students
          .map((s) => s.family_id)
          .filter((id): id is number => id != null),
      ).size;
      this.audienceCountCache.set(cacheKey, { value: count, expires: now + 60_000 });
      return count;
    }

    const campusIds = (post.campus_ids as number[]) ?? [];
    const classIds = (post.class_ids as number[]) ?? [];
    const sectionIds = (post.section_ids as number[]) ?? [];
    const studentStatuses = (post.student_statuses as student_status[]) ?? [];
    const academicYears = (post.academic_years as string[]) ?? [];

    const count = await this.prisma.families.count({
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
    this.audienceCountCache.set(cacheKey, { value: count, expires: now + 60_000 });
    return count;
  }
}
