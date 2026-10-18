import { BadRequestException } from '@nestjs/common';
import { clearTemplateCache } from '../../utils/notification-templates.util';
import { DefaulterNotifyService } from './defaulter-notify.service';

// TAFSD-384: "Notify through app" on the Defaulters report.

const user = { sub: 'u1', username: 'admin', role: 'CAMPUS_ADMIN' } as any;
const row = {
  cc: 42, gr_number: 'GR-1001', student_name: 'Ali Khan', campus: 'North Nazimabad', class_name: 'Class 5', section: 'B',
  months_behind: 3, arrears_outstanding: 24000, lps_outstanding: 500, oldest_arrear_month_label: 'Jul 2026',
};

function build(opts: { items?: unknown[]; config?: Record<string, string> } = {}) {
  clearTemplateCache();
  const config = opts.config ?? {};
  const prisma = {
    app_config: { findUnique: jest.fn(async ({ where }: any) => (where.key in config ? { value: config[where.key] } : null)) },
    defaulter_notifications: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ ...data, id: 1, sent_at: new Date('2026-10-19T10:00:00Z') })),
    },
  };
  const reports = { listDefaulters: jest.fn(async () => ({ items: opts.items ?? [row] })) };
  const noticeBoard = { createPost: jest.fn(async () => ({ id: 77, total_reached: 1 })) };
  const svc = new DefaulterNotifyService(prisma as any, reports as any, noticeBoard as any);
  return { svc, prisma, reports, noticeBoard };
}

describe('DefaulterNotifyService', () => {
  it('fills the default copy from the recomputed report row', async () => {
    const { svc, reports } = build();
    const p = await svc.preview(42, '2026-10-19', user);
    expect(reports.listDefaulters).toHaveBeenCalledWith(
      expect.objectContaining({ cc: 42, as_of_date: '2026-10-19', view: 'students' }),
      user,
    );
    expect(p.body).toContain('Ali Khan (GR-1001, Class 5 B)');
    expect(p.body).toContain('Rs. 24,500');
    expect(p.body).toContain('since Jul 2026');
  });

  it('uses the wording saved on Notification Templates', async () => {
    const { svc } = build({ config: { notif_fee_defaulter_body: '{student_name} owes {arrears_amount} + {late_fee_amount} late fee.' } });
    const p = await svc.preview(42, '2026-10-19', user);
    expect(p.body).toBe('Ali Khan owes Rs. 24,000 + Rs. 500 late fee.');
  });

  it('posts to that one student, skipping review, and records the send', async () => {
    const { svc, noticeBoard, prisma } = build();
    const res = await svc.send(42, '2026-10-19', user);
    expect(noticeBoard.createPost).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ student_ccs: [42], title: 'Outstanding School Fees' }),
      expect.anything(),
      user,
      { skipReview: true },
    );
    expect(prisma.defaulter_notifications.create.mock.calls[0][0].data).toMatchObject({
      student_id: 42, notice_post_id: 77, months_behind: 3,
    });
    expect(Number(prisma.defaulter_notifications.create.mock.calls[0][0].data.arrears_outstanding)).toBe(24500);
    expect(res.notice_post_id).toBe(77);
  });

  it('refuses a student who is not a defaulter', async () => {
    const { svc, noticeBoard } = build({ items: [] });
    await expect(svc.send(42, '2026-10-19', user)).rejects.toBeInstanceOf(BadRequestException);
    expect(noticeBoard.createPost).not.toHaveBeenCalled();
  });

  it('refuses when the notice type is switched off', async () => {
    const { svc, noticeBoard } = build({ config: { notif_fee_defaulter_disabled: 'true' } });
    await expect(svc.send(42, '2026-10-19', user)).rejects.toThrow(/switched off/);
    expect(noticeBoard.createPost).not.toHaveBeenCalled();
  });
});
