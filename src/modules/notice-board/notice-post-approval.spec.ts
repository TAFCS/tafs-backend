import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { NoticePostStatus, StaffRole } from '@prisma/client';
import { NoticeBoardService } from './notice-board.service';

// TAFSD-313/314: a post by anyone but a SUPER_ADMIN waits as PENDING, with no
// push, until a superadmin approves it.

const superAdmin = { sub: 'sa', role: StaffRole.SUPER_ADMIN } as any;
const campusAdmin = { sub: 'ca', role: StaffRole.CAMPUS_ADMIN } as any;

const row = (over: Record<string, unknown> = {}) => ({
  id: 7,
  posted_by: 'ca',
  title: 'Sports day',
  body: 'Friday',
  campus_ids: [1],
  class_ids: [],
  section_ids: [],
  student_ccs: [],
  student_statuses: [],
  academic_years: [],
  status: NoticePostStatus.PENDING,
  users: { full_name: 'Campus Admin' },
  ...over,
});

function build() {
  const prisma = {
    notice_board_posts: {
      create: jest.fn(async ({ data }) => row({ ...data, id: 7 })),
      findFirst: jest.fn(async () => row()),
      findUniqueOrThrow: jest.fn(async () => row({ status: NoticePostStatus.APPROVED })),
      update: jest.fn(async ({ data }) => row(data)),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    families: { count: jest.fn(async () => 3), findMany: jest.fn(async () => [{ id: 1 }]) },
    students: { findMany: jest.fn(async () => []) },
  };
  const fcm = { sendToFamily: jest.fn(async () => undefined), sendToUsers: jest.fn(async () => undefined) };
  const audit = { log: jest.fn(async () => undefined) };
  const gateway = { broadcastNoticeBoard: jest.fn() };
  // Unrestricted scope for both callers, so only the review rules are under test.
  const scope = { isExempt: () => true, scopeOf: () => ({ campuses: [], classes: [], sections: [], segments: [] }) };
  const service = new NoticeBoardService(prisma as any, {} as any, fcm as any, audit as any, gateway as any, scope as any);
  return { service, prisma, fcm, audit };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('notice board approval', () => {
  it('holds a non-superadmin post as PENDING and pushes nothing', async () => {
    const { service, prisma, fcm } = build();
    await service.createPost('ca', { body: 'Friday', campus_ids: [1] } as any, 'ca', campusAdmin);
    await flush();
    expect(prisma.notice_board_posts.create.mock.calls[0][0].data.status).toBe(NoticePostStatus.PENDING);
    expect(fcm.sendToFamily).not.toHaveBeenCalled();
  });

  it('publishes a superadmin post straight away', async () => {
    const { service, prisma, fcm } = build();
    await service.createPost('sa', { body: 'Friday' } as any, 'sa', superAdmin);
    await flush();
    expect(prisma.notice_board_posts.create.mock.calls[0][0].data.status).toBe(NoticePostStatus.APPROVED);
    expect(fcm.sendToFamily).toHaveBeenCalled();
  });

  it('publishes system posts made without a caller (e.g. change-request notices)', async () => {
    const { service, prisma } = build();
    await service.createPost('sys', { body: 'x' } as any);
    expect(prisma.notice_board_posts.create.mock.calls[0][0].data.status).toBe(NoticePostStatus.APPROVED);
  });

  it('approve flips PENDING atomically, re-dates the post and notifies families and the author', async () => {
    const { service, prisma, fcm } = build();
    await service.approvePost(7, superAdmin, 'sa');
    await flush();
    const call = prisma.notice_board_posts.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: 7, status: NoticePostStatus.PENDING });
    expect(call.data).toMatchObject({ status: NoticePostStatus.APPROVED, reviewed_by: 'sa' });
    expect(call.data.posted_at).toBeInstanceOf(Date);
    expect(fcm.sendToFamily).toHaveBeenCalled();
    expect(fcm.sendToUsers).toHaveBeenCalledWith(['ca'], 'Notice approved', expect.any(String), expect.any(Object));
  });

  it('refuses to decide a post that is no longer pending', async () => {
    const { service, prisma } = build();
    prisma.notice_board_posts.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.notice_board_posts.findFirst.mockResolvedValueOnce({ status: NoticePostStatus.APPROVED } as any);
    await expect(service.approvePost(7, superAdmin, 'sa')).rejects.toBeInstanceOf(ConflictException);
  });

  it('reject needs a reason and never notifies families', async () => {
    const { service, prisma, fcm } = build();
    await expect(service.rejectPost(7, '  ', superAdmin, 'sa')).rejects.toBeInstanceOf(BadRequestException);
    prisma.notice_board_posts.findUniqueOrThrow.mockResolvedValueOnce(row({ status: NoticePostStatus.REJECTED }) as any);
    await service.rejectPost(7, 'Wrong date', superAdmin, 'sa');
    await flush();
    expect(prisma.notice_board_posts.updateMany.mock.calls[0][0].data).toMatchObject({
      status: NoticePostStatus.REJECTED,
      review_reason: 'Wrong date',
    });
    expect(fcm.sendToFamily).not.toHaveBeenCalled();
  });

  it('only a superadmin can review', async () => {
    const { service } = build();
    await expect(service.approvePost(7, campusAdmin, 'ca')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.rejectPost(7, 'no', campusAdmin, 'ca')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getReviewQueue(undefined, undefined, campusAdmin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getPendingCount(campusAdmin)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a non-superadmin's new wording sends an approved post back to review; a pin does not", async () => {
    const { service, prisma } = build();
    prisma.notice_board_posts.findFirst.mockResolvedValue(row({ status: NoticePostStatus.APPROVED }) as any);
    await service.updatePost(7, { is_pinned: true }, 'ca', campusAdmin);
    expect(prisma.notice_board_posts.update.mock.calls[0][0].data.status).toBeUndefined();
    await service.updatePost(7, { body: 'Saturday' }, 'ca', campusAdmin);
    expect(prisma.notice_board_posts.update.mock.calls[1][0].data.status).toBe(NoticePostStatus.PENDING);
    await service.updatePost(7, { body: 'Sunday' }, 'sa', superAdmin);
    expect(prisma.notice_board_posts.update.mock.calls[2][0].data.status).toBeUndefined();
  });
});
