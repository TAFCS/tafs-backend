import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import * as path from 'path';

@Injectable()
export class NoticeBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
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
    return this.prisma.notice_board_posts.findMany({
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
  }

  async createPost(postedBy: string, dto: CreatePostDto) {
    return this.prisma.notice_board_posts.create({
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
  }

  async updatePost(id: number, dto: UpdatePostDto) {
    const post = await this.prisma.notice_board_posts.findFirst({
      where: { id, deleted_at: null },
    });
    if (!post) throw new NotFoundException('Post not found');

    return this.prisma.notice_board_posts.update({
      where: { id },
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

  async deletePost(id: number) {
    const post = await this.prisma.notice_board_posts.findFirst({
      where: { id, deleted_at: null },
    });
    if (!post) throw new NotFoundException('Post not found');

    return this.prisma.notice_board_posts.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
  }

  async getReadStats(postId: number) {
    const post = await this.prisma.notice_board_posts.findFirst({
      where: { id: postId, deleted_at: null },
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
      post_id: postId,
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
