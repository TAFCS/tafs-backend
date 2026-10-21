import { BadRequestException } from '@nestjs/common';
import { NoticePostStatus } from '@prisma/client';
import { NoticeBoardService } from './notice-board.service';

// TAFSD-405: a notice's attachments can be changed after posting.

const staff = { sub: 'u1', role: 'CAMPUS_ADMIN' } as any;

function build(post: any) {
  const svc = Object.create(NoticeBoardService.prototype) as any;
  const update = jest.fn(async ({ data }: any) => ({ ...post, ...data }));
  svc.prisma = { notice_board_posts: { findFirst: jest.fn(async () => post), update } };
  svc.assertCanManagePost = jest.fn();
  svc.auditLogs = { log: jest.fn() };
  return { svc, update };
}

const post = (over: any = {}) => ({
  id: 7, title: 'Trip', body: 'Friday', posted_by: 'u1', is_pinned: false, expires_at: null,
  media_urls: ['a.jpg', 'b.pdf'], media_types: ['IMAGE', 'DOCUMENT'], status: NoticePostStatus.PENDING, ...over,
});

describe('editing a notice’s attachments', () => {
  it('replaces the list and audit-logs what was added and removed', async () => {
    const { svc, update } = build(post());
    await svc.updatePost(7, { media_urls: ['a.jpg', 'c.jpg'], media_types: ['IMAGE', 'IMAGE'] }, 'me', staff);
    expect(update.mock.calls[0][0].data).toMatchObject({ media_urls: ['a.jpg', 'c.jpg'], media_types: ['IMAGE', 'IMAGE'] });
    expect(svc.auditLogs.log.mock.calls[0][0].note).toContain('attachments 2 → 2 (1 added, 1 removed)');
  });

  it('sends an approved notice back for review when a non-superadmin changes attachments', async () => {
    const { svc, update } = build(post({ status: NoticePostStatus.APPROVED }));
    await svc.updatePost(7, { media_urls: [], media_types: [] }, 'me', staff);
    expect(update.mock.calls[0][0].data.status).toBe(NoticePostStatus.PENDING);
  });

  it('leaves attachments alone when they are not sent', async () => {
    const { svc, update } = build(post());
    await svc.updatePost(7, { title: 'Trip (updated)' }, 'me', staff);
    expect(update.mock.calls[0][0].data.media_urls).toBeUndefined();
  });

  it('rejects urls and types that do not line up', async () => {
    const { svc } = build(post());
    await expect(svc.updatePost(7, { media_urls: ['a.jpg'], media_types: [] }, 'me', staff)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.updatePost(7, { media_urls: ['a.jpg'] }, 'me', staff)).rejects.toBeInstanceOf(BadRequestException);
  });
});
