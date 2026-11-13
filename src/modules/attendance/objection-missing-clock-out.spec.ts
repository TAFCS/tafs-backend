import { AttendanceObjectionStatus, StaffAttendanceStatus } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { AttendanceObjectionsService } from './attendance-objections.service';

jest.mock('../../common/auth/super-admin', () => ({
  ...jest.requireActual('../../common/auth/super-admin'),
  assertMayChangeEmployee: jest.fn(async () => undefined),
}));

// TAFSD-479 and TAFSD-489: what accepting an objection writes to the day.

const DAY = new Date('2026-11-05T00:00:00Z');
const at = (hhmm: string) => new Date(`2026-11-05T${hhmm}:00Z`);

type Opts = {
  scans: string[];
  claimed: string;
  /** Index into `scans` of the punch objected to; none = a day objection. */
  objectTo?: number;
  direction?: 'IN' | 'OUT' | null;
  daily?: { check_in_at: Date | null; check_out_at: Date | null };
  status?: AttendanceObjectionStatus;
  raceLost?: boolean;
  claimedOut?: string;
};

function setup(opts: Opts) {
  const scans = opts.scans.map((t, i) => ({ id: 100 + i, scan_time: at(t) }));
  const scan = opts.objectTo != null
    ? { id: 100 + opts.objectTo, scan_time: at(opts.scans[opts.objectTo]), direction: opts.direction ?? null }
    : null;
  const existing = {
    id: 1,
    employee_id: 9,
    attendance_date: DAY,
    status: opts.status ?? AttendanceObjectionStatus.PENDING,
    scan_id: scan?.id ?? null,
    scan,
    claimed_time: at(opts.claimed),
    claimed_check_out_time: opts.claimedOut ? at(opts.claimedOut) : null,
    original_scan_time: null,
    reason: 'Punch was wrong',
    created_at: at('18:00'),
    employee: {
      id: 9, campus_id: 2, user_id: 'u9', full_name: 'Test Teacher', employee_code: 'T1',
      leaving_time: new Date('1970-01-01T16:00:00Z'), reporting_time: new Date('1970-01-01T08:00:00Z'),
      employee_day_timings: [],
    },
  };
  const upsert = jest.fn(async () => ({}));
  const staffNotifications = { notify: jest.fn(async () => undefined) };
  const prisma: any = {
    attendance_objections: {
      findUnique: jest.fn(async () => existing),
      updateMany: jest.fn(async () => ({ count: opts.raceLost ? 0 : 1 })),
      findUniqueOrThrow: jest.fn(async () => ({ ...existing, scan })),
    },
    zk_attendance_scans: {
      findMany: jest.fn(async () => scans),
      update: jest.fn(),
    },
    attendance_staff_daily: {
      findUnique: jest.fn(async () => opts.daily ?? null),
      upsert,
    },
    payroll_flags: { deleteMany: jest.fn(async () => ({})) },
  };
  const svc = new AttendanceObjectionsService(
    prisma,
    {} as any,
    { sendToUsers: jest.fn(async () => undefined) } as any,
    { log: jest.fn() } as any,
    { assertEmployee: jest.fn(), assertCampus: jest.fn() } as any,
    {
      resolveExpectedTimes: jest.fn(async () => ({
        expectedCheckIn: new Date('1970-01-01T08:00:00Z'),
        expectedCheckOut: new Date('1970-01-01T16:00:00Z'),
        graceMinutes: 10,
      })),
    } as any,
    staffNotifications as any,
  );
  const user = { sub: 'hr1', role: 'HR', campusId: 2 } as any;
  const accept = () => svc.review(1, { status: AttendanceObjectionStatus.ACCEPTED, admin_notes: 'ok' } as any, user);
  const saved = () => (upsert.mock.calls[0] as any)[0].update;
  return { accept, saved, upsert, staffNotifications };
}

describe('TAFSD-479: accepting a missing clock-out', () => {
  it('keeps the morning punch and records the claimed time as the clock-out', async () => {
    const t = setup({ scans: ['08:05'], claimed: '16:10' });
    await t.accept();
    expect(t.saved().check_in_at).toEqual(at('08:05'));
    expect(t.saved().check_out_at).toEqual(at('16:10'));
  });

  it('works for an overridden day with a check-in and no check-out', async () => {
    const t = setup({ scans: [], claimed: '15:45', daily: { check_in_at: at('08:00'), check_out_at: null } });
    await t.accept();
    expect(t.saved().check_in_at).toEqual(at('08:00'));
    expect(t.saved().check_out_at).toEqual(at('15:45'));
  });

  it('a whole-day objection with no punches records the claimed arrival and the schedule leaving time', async () => {
    const t = setup({ scans: [], claimed: '08:05' });
    await t.accept();
    expect(t.saved().check_in_at).toEqual(at('08:05'));
    expect(t.saved().check_out_at).toEqual(at('16:00'));
  });
});

describe('TAFSD-489 (57): accepting keeps lateness', () => {
  it('a corrected check-in that is still late is saved as LATE', async () => {
    const t = setup({ scans: ['08:40', '16:00'], objectTo: 0, direction: 'IN', claimed: '08:20' });
    await t.accept();
    expect(t.saved().check_in_at).toEqual(at('08:20'));
    expect(t.saved().status).toBe(StaffAttendanceStatus.LATE);
  });

  it('a corrected check-in inside the grace window is PRESENT', async () => {
    const t = setup({ scans: ['08:40', '16:00'], objectTo: 0, direction: 'IN', claimed: '08:05' });
    await t.accept();
    expect(t.saved().status).toBe(StaffAttendanceStatus.PRESENT);
  });

  it('a missing clock-out keeps the late arrival LATE', async () => {
    const t = setup({ scans: ['08:30'], claimed: '16:00' });
    await t.accept();
    expect(t.saved().status).toBe(StaffAttendanceStatus.LATE);
  });
});

describe('TAFSD-489 (58): a whole-day objection keeps the real clock-out', () => {
  it('keeps the last punch of a complete day', async () => {
    const t = setup({ scans: ['09:10', '15:30'], claimed: '08:00' });
    await t.accept();
    expect(t.saved().check_in_at).toEqual(at('08:00'));
    expect(t.saved().check_out_at).toEqual(at('15:30'));
  });

  it("keeps an override's check-out", async () => {
    const t = setup({ scans: [], claimed: '08:00', daily: { check_in_at: at('09:00'), check_out_at: at('14:00') } });
    await t.accept();
    expect(t.saved().check_out_at).toEqual(at('14:00'));
  });
});

describe('TAFSD-489 (59): a punch with no direction is read by position', () => {
  it('the second punch of the day is the clock-out', async () => {
    const t = setup({ scans: ['08:00', '15:00'], objectTo: 1, direction: null, claimed: '16:00' });
    await t.accept();
    expect(t.saved().check_out_at).toEqual(at('16:00'));
    expect(t.saved().check_in_at).toBeUndefined();
  });

  it('the first punch of the day is the clock-in', async () => {
    const t = setup({ scans: ['08:30', '16:00'], objectTo: 0, direction: null, claimed: '08:00' });
    await t.accept();
    expect(t.saved().check_in_at).toEqual(at('08:00'));
  });
});

describe('TAFSD-489 (60): an objection is decided once', () => {
  it('refuses an objection that was already decided', async () => {
    const t = setup({ scans: ['08:00'], claimed: '16:00', status: AttendanceObjectionStatus.REJECTED });
    await expect(t.accept()).rejects.toBeInstanceOf(ConflictException);
    expect(t.upsert).not.toHaveBeenCalled();
  });

  it('refuses when another reviewer decided it a moment earlier', async () => {
    const t = setup({ scans: ['08:00'], claimed: '16:00', raceLost: true });
    await expect(t.accept()).rejects.toBeInstanceOf(ConflictException);
    expect(t.upsert).not.toHaveBeenCalled();
  });
});

describe('TAFSD-490: a whole-day objection with both times', () => {
  it('saves the claimed clock-in and clock-out', async () => {
    const t = setup({ scans: ['09:10', '15:30'], claimed: '08:00', claimedOut: '16:00' });
    await t.accept();
    expect(t.saved().check_in_at).toEqual(at('08:00'));
    expect(t.saved().check_out_at).toEqual(at('16:00'));
  });

  it('is not mistaken for a missing clock-out on a day with one punch', async () => {
    const t = setup({ scans: ['10:00'], claimed: '08:00', claimedOut: '16:00' });
    await t.accept();
    expect(t.saved().check_in_at).toEqual(at('08:00'));
    expect(t.saved().check_out_at).toEqual(at('16:00'));
  });
});

describe('TAFSD-490: raising a whole-day objection', () => {
  const svc = () =>
    new AttendanceObjectionsService(
      {} as any,
      { requireByUserId: jest.fn(async () => ({ id: 9, full_name: 'T' })) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  const base = { attendance_date: '2026-11-05', claimed_time: '2026-11-05T08:00:00Z', reason: 'Device was down' };

  it('rejects a clock-out that is not after the clock-in', async () => {
    await expect(
      svc().create('u9', { ...base, claimed_check_out_time: '2026-11-05T07:30:00Z' } as any),
    ).rejects.toThrow('Clock-out must be after clock-in');
  });

  it('rejects a clock-out on an objection about one punch', async () => {
    await expect(
      svc().create('u9', { ...base, scan_id: 5, claimed_check_out_time: '2026-11-05T16:00:00Z' } as any),
    ).rejects.toThrow('only for a whole-day objection');
  });
});

describe('TAFSD-513 (item 68): the decision reaches the staff app notice inbox', () => {
  it('accepting sends a staff notification (notice + push) that opens My objections', async () => {
    const t = setup({ scans: ['08:05'], objectTo: 0, direction: 'IN', claimed: '07:55' });
    await t.accept();
    expect(t.staffNotifications.notify).toHaveBeenCalledWith(
      'u9',
      expect.objectContaining({
        kind: 'OBJECTION_ACCEPTED',
        title: 'Attendance objection accepted',
        body: expect.stringContaining('Your attendance objection for'),
        pushData: expect.objectContaining({ route: '/my-objections', objection_id: '1' }),
      }),
    );
  });
});
