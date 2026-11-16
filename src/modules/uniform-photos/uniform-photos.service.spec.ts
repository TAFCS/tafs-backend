import { StaffRole } from '@prisma/client';
import { UNIFORM_PHOTO_ACTION_KEY, UNIFORM_PHOTO_LINK, UNIFORM_PHOTO_REMINDER_KIND } from './uniform-photo.constants';
import { reminderText, startOfTodayPkt, UniformPhotosService } from './uniform-photos.service';

function build(opts: {
  direct?: string[];
  viaPack?: string[];
  sessions?: Record<string, { isActive: boolean; actionIds: string[] } | null>;
  sentToday?: string[];
  pending?: Record<string, { photograph_url: string | null; campuses: { campus_code: string } }[]>;
}) {
  const notify = jest.fn().mockResolvedValue(undefined);
  let currentUser = '';
  const prisma: any = {
    user_tile_action_grants: { findMany: jest.fn().mockResolvedValue((opts.direct ?? []).map((user_id) => ({ user_id }))) },
    user_access_packs: { findMany: jest.fn().mockResolvedValue((opts.viaPack ?? []).map((user_id) => ({ user_id }))) },
    staff_notifications: {
      count: jest.fn(({ where }) => Promise.resolve((opts.sentToday ?? []).includes(where.user_id) ? 1 : 0)),
    },
    users: {
      findUnique: jest.fn(({ where }) => {
        currentUser = where.id;
        return Promise.resolve({ role: StaffRole.ADMIN });
      }),
    },
    students: { findMany: jest.fn(() => Promise.resolve(opts.pending?.[currentUser] ?? [])) },
  };
  const scope: any = { resolveEffective: jest.fn().mockResolvedValue({}), whereForStudents: jest.fn().mockReturnValue({}) };
  const access: any = {
    resolveLiveSession: jest.fn((id: string) =>
      Promise.resolve(opts.sessions?.[id] ?? { isActive: true, actionIds: [UNIFORM_PHOTO_ACTION_KEY] }),
    ),
  };
  const service = new UniformPhotosService(prisma, scope, access, { notify } as any, { log: jest.fn() } as any);
  return { service, notify, prisma };
}

const at = (code: string, photo: string | null = 'x.jpg') => ({ photograph_url: photo, campuses: { campus_code: code } });

describe('uniform photo reminders (TAFSD-527)', () => {
  it('starts the reminder day at midnight in Pakistan', () => {
    // 02:00 PKT on the 16th is 21:00 UTC on the 15th.
    expect(startOfTodayPkt(new Date('2026-11-15T21:00:00Z')).toISOString()).toBe('2026-11-15T19:00:00.000Z');
    expect(startOfTodayPkt(new Date('2026-11-16T10:00:00Z')).toISOString()).toBe('2026-11-15T19:00:00.000Z');
  });

  it('words the count, campuses and the no-photo ones', () => {
    expect(reminderText(1, 0, ['GEJ']).body).toBe(
      '1 new student at GEJ still has only the admission photo. Upload a photo in school uniform to clear it.',
    );
    expect(reminderText(31, 4, ['GEJ', 'KNF']).body).toBe(
      '31 new students at GEJ, KNF still have only the admission photo (4 with no photo at all). Upload a photo in school uniform to clear them.',
    );
  });

  it('reminds only people with an explicit tick, once each, deduped across person and pack', async () => {
    const { service, notify } = build({
      direct: ['a', 'b'],
      viaPack: ['b', 'c'],
      pending: { a: [at('GEJ'), at('KNF', null)], b: [at('GEJ')], c: [at('NNZ')] },
    });
    const res = await service.sendDailyReminders();
    expect(res).toMatchObject({ recipients: 3, notified: 3 });
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledWith('a', expect.objectContaining({
      kind: UNIFORM_PHOTO_REMINDER_KIND,
      link: UNIFORM_PHOTO_LINK,
      body: expect.stringContaining('2 new students at GEJ, KNF'),
    }));
  });

  it('skips a deactivated login and one whose tick is overridden by a deny', async () => {
    const { service, notify } = build({
      direct: ['inactive', 'denied', 'ok'],
      sessions: {
        inactive: { isActive: false, actionIds: [UNIFORM_PHOTO_ACTION_KEY] },
        denied: { isActive: true, actionIds: ['student.directory#view'] },
      },
      pending: { ok: [at('GEJ')] },
    });
    await service.sendDailyReminders();
    expect(notify.mock.calls.map((c) => c[0])).toEqual(['ok']);
  });

  it('sends nothing for a count of zero, and nothing twice in a day', async () => {
    const { service, notify } = build({
      direct: ['empty', 'already', 'due'],
      sentToday: ['already'],
      pending: { already: [at('GEJ')], due: [at('GEJ')] },
    });
    const res = await service.sendDailyReminders();
    expect(res).toMatchObject({ notified: 1, skipped_already_sent: 1, skipped_nothing_pending: 1 });
    expect(notify.mock.calls.map((c) => c[0])).toEqual(['due']);
  });
});
