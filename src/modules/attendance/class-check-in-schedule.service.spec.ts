import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClassCheckInScheduleService } from './class-check-in-schedule.service';

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);

const EXISTING = {
  id: 1,
  campus_id: 7,
  class_id: 6,
  expected_check_in: time('08:00'),
  end_time: time('14:00'),
  intermediate_time: time('11:30'),
  effective_from: new Date('2026-09-01T00:00:00.000Z'),
  classes: { id: 6, description: 'Class VI', class_code: 'VI' },
};

const makeService = (overrides: {
  duplicate?: unknown;
  existing?: typeof EXISTING;
  /** Make ScopeService.assertCampus reject, as it does for an out-of-scope user. */
  outOfScope?: boolean;
} = {}) => {
  const prisma = {
    class_check_in_schedules: {
      findFirst: jest.fn().mockResolvedValue(overrides.duplicate ?? null),
      findUnique: jest.fn().mockResolvedValue(overrides.existing ?? EXISTING),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: any) => ({ ...EXISTING, ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => ({ ...(overrides.existing ?? EXISTING), ...data })),
      delete: jest.fn(),
    },
    class_timing_notifications: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
  const timingNotifications = {
    notifyPairing: jest.fn().mockResolvedValue({
      students_matched: 3,
      families_notified: 2,
      skipped_no_family: 1,
      failed: 0,
      failures: [],
      notification_id: 99,
    }),
    buildMessage: jest.fn(),
  };

  const scope = {
    assertCampus: jest.fn(() => {
      if (overrides.outOfScope) throw new ForbiddenException('out of scope');
    }),
    assertClass: jest.fn(),
  };

  const service = new ClassCheckInScheduleService(
    prisma as never,
    auditLogs as never,
    scope as never,
    timingNotifications as never,
  );
  return { service, prisma, auditLogs, scope, timingNotifications };
};

/** A staff token with no legacy campus pin, so only ScopeService decides. */
const USER = { sub: 'u1', campusId: null } as never;

const baseCreate = {
  class_id: 6,
  campus_id: 7,
  expected_check_in: '08:00',
  end_time: '14:00',
  intermediate_time: '11:30',
  effective_from: '2026-09-01',
};

describe('ClassCheckInScheduleService', () => {
  describe('time ordering', () => {
    it('accepts start < intermediate < end', async () => {
      const { service, prisma } = makeService();
      await service.create(baseCreate);
      expect(prisma.class_check_in_schedules.create).toHaveBeenCalled();
    });

    it('rejects an end time before the start', async () => {
      const { service } = makeService();
      await expect(
        service.create({ ...baseCreate, end_time: '07:00' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an intermediate time before the start — every punch would be a check-out', async () => {
      const { service } = makeService();
      await expect(
        service.create({ ...baseCreate, intermediate_time: '07:30' }),
      ).rejects.toThrow(/after the start time/);
    });

    it('rejects an intermediate time after the end — no punch would ever be a check-out', async () => {
      const { service } = makeService();
      await expect(
        service.create({ ...baseCreate, intermediate_time: '15:00' }),
      ).rejects.toThrow(/before the end time/);
    });

    it('allows omitting both the end and the intermediate time', async () => {
      const { service, prisma } = makeService();
      await service.create({ ...baseCreate, end_time: null, intermediate_time: null });
      expect(prisma.class_check_in_schedules.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ end_time: null, intermediate_time: null }),
        }),
      );
    });

    it('validates the row as it will be, not just the fields being edited', async () => {
      // Moving only the start past the stored 11:30 cut-off must be rejected.
      const { service } = makeService();
      await expect(service.update(1, { expected_check_in: '12:00' })).rejects.toThrow(
        /after the start time/,
      );
    });
  });

  describe('duplicate detection is scoped to campus + class + date', () => {
    it('includes the campus in the lookup', async () => {
      const { service, prisma } = makeService();
      await service.create(baseCreate);
      expect(prisma.class_check_in_schedules.findFirst).toHaveBeenCalledWith({
        where: { campus_id: 7, class_id: 6, effective_from: new Date('2026-09-01T00:00:00.000Z') },
      });
    });

    it('rejects a second schedule for the same pairing and date', async () => {
      const { service } = makeService({ duplicate: { id: 42 } });
      await expect(service.create(baseCreate)).rejects.toThrow(/already exists/);
    });
  });

  describe('campus scope (merged from the sub-permissions work)', () => {
    it('lets an internal caller through when no user is passed', async () => {
      const { service, scope } = makeService({ outOfScope: true });
      await expect(service.create(baseCreate)).resolves.toBeDefined();
      expect(scope.assertCampus).not.toHaveBeenCalled();
    });

    it('checks campus and class before creating', async () => {
      const { service, scope } = makeService();
      await service.create(baseCreate, undefined, undefined, USER);
      expect(scope.assertCampus).toHaveBeenCalledWith(USER, 7);
      expect(scope.assertClass).toHaveBeenCalledWith(USER, 6);
    });

    it('refuses a create outside the caller\'s scope', async () => {
      const { service, prisma } = makeService({ outOfScope: true });
      await expect(service.create(baseCreate, undefined, undefined, USER)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.class_check_in_schedules.create).not.toHaveBeenCalled();
    });

    it('scopes the notification preview too — it reveals a family count', async () => {
      const { service } = makeService({ outOfScope: true });
      await expect(
        service.previewNotification(
          {
            campusId: 7,
            classId: 6,
            expectedCheckIn: '08:00',
            endTime: '14:00',
            effectiveFrom: '2026-09-01',
          },
          USER,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('parent notification', () => {
    it('does not notify unless asked', async () => {
      const { service, timingNotifications } = makeService();
      const result = await service.create(baseCreate);
      expect(timingNotifications.notifyPairing).not.toHaveBeenCalled();
      expect(result.notification_report).toBeNull();
      expect(result.notification_warning).toBeNull();
    });

    it('sends start and end only — never the intermediate time', async () => {
      const { service, timingNotifications } = makeService();
      await service.create({ ...baseCreate, notify_parents: true });

      const [args] = timingNotifications.notifyPairing.mock.calls[0];
      expect(args).toMatchObject({
        campusId: 7,
        classId: 6,
        startTime: time('08:00'),
        endTime: time('14:00'),
      });
      expect(JSON.stringify(args)).not.toContain('11:30');
      expect(Object.keys(args)).not.toContain('intermediateTime');
    });

    it('reports coverage back to the caller', async () => {
      const { service } = makeService();
      const result = await service.create({ ...baseCreate, notify_parents: true });
      expect(result.notification_report).toMatchObject({ families_notified: 2, students_matched: 3 });
      expect(result.notification_warning).toContain('2 family(ies) notified for 3 student(s)');
    });

    it('keeps the saved schedule when notifying blows up', async () => {
      const { service, timingNotifications, prisma } = makeService();
      timingNotifications.notifyPairing.mockRejectedValue(new Error('FCM down'));

      const result = await service.create({ ...baseCreate, notify_parents: true });

      // The row is what the punch pipeline reads — it must survive.
      expect(prisma.class_check_in_schedules.create).toHaveBeenCalled();
      expect(result.notification_report).toBeNull();
      expect(result.notification_warning).toContain('FCM down');
    });
  });
});
