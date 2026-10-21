import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NoticePostStatus } from '@prisma/client';
import { NoticeBoardService } from './notice-board.service';

// TAFSD-404: the poster can edit / delete their own notice until it is approved.

const me = { sub: 'u1', role: 'CAMPUS_ADMIN' } as any;

function build(post: any) {
  const svc = Object.create(NoticeBoardService.prototype) as any;
  svc.prisma = { notice_board_posts: { findFirst: jest.fn(async () => post) } };
  svc.updatePost = jest.fn(async () => ({ ok: true }));
  svc.deletePost = jest.fn(async () => ({ ok: true }));
  return svc;
}

describe('own notice before approval', () => {
  it.each([NoticePostStatus.PENDING, NoticePostStatus.REJECTED])('edits a %s notice, without pinning', async (status) => {
    const svc = build({ id: 7, posted_by: 'u1', status });
    await svc.updateOwnPost('7', { title: 'Fixed', is_pinned: true }, 'me', me);
    expect(svc.updatePost).toHaveBeenCalledWith(7, { title: 'Fixed' }, 'me', me);
  });

  it('deletes a pending notice', async () => {
    const svc = build({ id: 7, posted_by: 'u1', status: NoticePostStatus.PENDING });
    await svc.deleteOwnPost('7', 'me', me);
    expect(svc.deletePost).toHaveBeenCalledWith(7, 'me', me);
  });

  it('refuses an approved notice', async () => {
    const svc = build({ id: 7, posted_by: 'u1', status: NoticePostStatus.APPROVED });
    await expect(svc.deleteOwnPost('7', 'me', me)).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.deletePost).not.toHaveBeenCalled();
  });

  it("hides someone else's notice", async () => {
    const svc = build({ id: 7, posted_by: 'someone-else', status: NoticePostStatus.PENDING });
    await expect(svc.updateOwnPost('7', { title: 'x' }, 'me', me)).rejects.toBeInstanceOf(NotFoundException);
    expect(svc.updatePost).not.toHaveBeenCalled();
  });
});
