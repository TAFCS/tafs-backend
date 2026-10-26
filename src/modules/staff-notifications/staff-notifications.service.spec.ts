import { NotFoundException } from '@nestjs/common';
import { StaffNotificationsService } from './staff-notifications.service';

// TAFSD-429: a staff member's own notifications.

function build(employee: { id: number } | null) {
  const row = { id: 5, user_id: 'u1', kind: 'NOTICE_APPROVED', title: 'T', body: 'B', read_at: null };
  const prisma = {
    staff_notifications: {
      create: jest.fn(async () => row),
      findMany: jest.fn(async () => [row]),
      count: jest.fn(async () => 1),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    employee_profiles: { findFirst: jest.fn(async () => employee) },
  };
  const fcm = { sendToUsers: jest.fn(async () => undefined) };
  const notices = { createPersonalNotice: jest.fn(async () => ({ id: 9 })) };
  const gateway = { emitToStaff: jest.fn() };
  const moduleRef = { get: jest.fn(() => gateway) };
  const svc = new StaffNotificationsService(prisma as any, fcm as any, notices as any, moduleRef as any);
  return { svc, prisma, fcm, notices, gateway, row };
}

const input = { kind: 'NOTICE_APPROVED', title: 'Your notice was approved', body: '"Trip" is now live.', link: '/notice-board?post=7', pushData: { post_id: '7' } };

describe('StaffNotificationsService', () => {
  it('stores it, sends it live, and posts a staff app notice to someone with an employee profile', async () => {
    const { svc, prisma, fcm, notices, gateway, row } = build({ id: 42 });
    await svc.notify('u1', input);
    expect(prisma.staff_notifications.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ user_id: 'u1', kind: 'NOTICE_APPROVED', link: '/notice-board?post=7' }),
    });
    expect(gateway.emitToStaff).toHaveBeenCalledWith('u1', 'staffNotification', row);
    expect(notices.createPersonalNotice).toHaveBeenCalledWith(42, 'u1', input.title, input.body, 'NOTICE_APPROVED');
    expect(fcm.sendToUsers).not.toHaveBeenCalled();
  });

  it('pushes directly to someone without an employee profile', async () => {
    const { svc, fcm, notices } = build(null);
    await svc.notify('u1', input);
    expect(notices.createPersonalNotice).not.toHaveBeenCalled();
    expect(fcm.sendToUsers).toHaveBeenCalledWith(['u1'], input.title, input.body, { type: 'NOTICE_APPROVED', post_id: '7' });
  });

  it('never throws, so a failed notification cannot undo what it reports', async () => {
    const { svc, prisma, notices } = build({ id: 42 });
    prisma.staff_notifications.create.mockRejectedValueOnce(new Error('db down'));
    notices.createPersonalNotice.mockRejectedValueOnce(new Error('push down'));
    await expect(svc.notify('u1', input)).resolves.toBeUndefined();
  });

  it('reads and marks only the caller’s own notifications', async () => {
    const { svc, prisma } = build(null);
    await svc.list('u1');
    expect(prisma.staff_notifications.findMany.mock.calls[0][0].where).toEqual({ user_id: 'u1' });
    await svc.markRead('u1', 5);
    expect(prisma.staff_notifications.updateMany.mock.calls[0][0].where).toEqual({ id: 5, user_id: 'u1', read_at: null });
    prisma.staff_notifications.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.staff_notifications.count.mockResolvedValueOnce(0);
    await expect(svc.markRead('u1', 99)).rejects.toBeInstanceOf(NotFoundException);
  });
});
