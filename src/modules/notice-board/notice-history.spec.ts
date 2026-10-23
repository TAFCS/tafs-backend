import { NotFoundException } from '@nestjs/common';
import { NoticePostStatus } from '@prisma/client';
import { NoticeBoardService } from './notice-board.service';

// TAFSD-416: the author sees why their notice was rejected and what others changed.

const author = { sub: 'u1', role: 'CAMPUS_ADMIN' } as any;
const admin = { sub: 'a1', role: 'SUPER_ADMIN' } as any;

const post = (over: any = {}) => ({
  id: 7, title: 'Trip', body: 'Friday', posted_by: 'u1', is_pinned: false, expires_at: null,
  media_urls: [], media_types: [], status: NoticePostStatus.PENDING, campus_ids: [], class_ids: [], section_ids: [], student_ccs: [],
  users: { full_name: 'Author' }, reviewer: null, review_reason: null, reviewed_at: null, ...over,
});

function build(p: any, logs: any[] = [], canManage = true) {
  const svc = Object.create(NoticeBoardService.prototype) as any;
  const update = jest.fn(async ({ data }: any) => ({ ...p, ...data }));
  svc.prisma = {
    notice_board_posts: { findFirst: jest.fn(async () => p), update },
    audit_logs: { findMany: jest.fn(async () => logs) },
  };
  svc.assertCanManagePost = jest.fn(async () => {
    if (!canManage) throw new NotFoundException('Post not found');
  });
  svc.auditLogs = { log: jest.fn() };
  svc.fcm = { sendToUsers: jest.fn(async () => undefined) };
  return svc;
}

describe('notice edit history', () => {
  it('keeps the full wording before and after, and tells the author when someone else edits', async () => {
    const svc = build(post());
    await svc.updatePost(7, { body: 'Saturday instead' }, 'Admin', admin);
    const entry = svc.auditLogs.log.mock.calls[0][0];
    expect(JSON.parse(entry.old_value)).toEqual({ title: 'Trip', body: 'Friday' });
    expect(JSON.parse(entry.new_value)).toEqual({ title: 'Trip', body: 'Saturday instead' });
    expect(svc.fcm.sendToUsers).toHaveBeenCalledWith(['u1'], 'Notice edited', expect.stringContaining('Admin'), expect.anything());
  });

  it("doesn't notify the author about their own edit", async () => {
    const svc = build(post());
    await svc.updatePost(7, { body: 'Saturday' }, 'Author', author);
    expect(svc.fcm.sendToUsers).not.toHaveBeenCalled();
  });

  it('gives the author the rejection reason and the edits', async () => {
    const svc = build(
      post({ status: NoticePostStatus.REJECTED, review_reason: 'Wrong date', reviewer: { full_name: 'Admin' } }),
      [
        { id: 1, action: 'CREATED', field: null, old_value: null, new_value: 'Trip', changed_by: 'Author', changed_at: new Date(), note: '' },
        { id: 2, action: 'UPDATED', field: 'Wording', old_value: '{"title":"Trip","body":"Friday"}', new_value: '{"title":"Trip","body":"Sat"}', changed_by: 'Admin', changed_at: new Date(), note: '' },
        { id: 3, action: 'REJECTED', field: null, old_value: null, new_value: 'Wrong date', changed_by: 'Admin', changed_at: new Date(), note: '' },
      ],
    );
    const h = await svc.getPostHistory(7, author);
    expect(h).toMatchObject({ status: 'REJECTED', review_reason: 'Wrong date', reviewed_by: 'Admin' });
    expect(h.events[1]).toMatchObject({ action: 'UPDATED', before: { body: 'Friday' }, after: { body: 'Sat' } });
    expect(h.events[2]).toMatchObject({ action: 'REJECTED', reason: 'Wrong date' });
    expect(svc.assertCanManagePost).not.toHaveBeenCalled();
  });

  it("hides another person's notice from someone who can't manage it", async () => {
    const svc = build(post({ posted_by: 'someone-else' }), [], false);
    await expect(svc.getPostHistory(7, author)).rejects.toBeInstanceOf(NotFoundException);
  });
});
