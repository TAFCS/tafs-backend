import { AttendanceObjectionStatus } from '@prisma/client';
import { AttendanceObjectionsService } from './attendance-objections.service';

jest.mock('../../common/auth/super-admin', () => ({
  ...jest.requireActual('../../common/auth/super-admin'),
  assertMayChangeEmployee: jest.fn(async () => undefined),
}));

// TAFSD-479: the staff app sends "Missing clock-out" with no scan. Accepting it
// used to record the claimed leaving time as the check-in.

const DAY = new Date('2026-11-05T00:00:00Z');
const at = (hhmm: string) => new Date(`2026-11-05T${hhmm}:00Z`);

function setup(opts: { scans: string[]; claimed: string; daily?: { check_in_at: Date | null; check_out_at: Date | null } }) {
  const existing = {
    id: 1,
    employee_id: 9,
    attendance_date: DAY,
    scan_id: null,
    scan: null,
    claimed_time: at(opts.claimed),
    original_scan_time: null,
    reason: 'Forgot to punch out',
    created_at: at('18:00'),
    employee: {
      id: 9, campus_id: 2, user_id: 'u9', full_name: 'Test Teacher', employee_code: 'T1',
      leaving_time: new Date('1970-01-01T16:00:00Z'), reporting_time: new Date('1970-01-01T08:00:00Z'),
      employee_day_timings: [],
    },
  };
  const upsert = jest.fn(async () => ({}));
  const prisma: any = {
    attendance_objections: {
      findUnique: jest.fn(async () => existing),
      update: jest.fn(async () => ({ ...existing, employee: existing.employee, scan: null })),
    },
    zk_attendance_scans: {
      findMany: jest.fn(async () => opts.scans.map((t) => ({ scan_time: at(t) }))),
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
  );
  const user = { sub: 'hr1', role: 'HR', campusId: 2 } as any;
  const accept = () => svc.review(1, { status: AttendanceObjectionStatus.ACCEPTED, admin_notes: 'ok' } as any, user);
  const saved = () => (upsert.mock.calls[0] as any)[0].update;
  return { accept, saved };
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

  it('a whole-day objection with no punches still records the claimed arrival', async () => {
    const t = setup({ scans: [], claimed: '08:20' });
    await t.accept();
    expect(t.saved().check_in_at).toEqual(at('08:20'));
    expect(t.saved().check_out_at).toEqual(at('16:00'));
  });

  it('a whole-day objection on a day with a full punch pair is unchanged', async () => {
    const t = setup({ scans: ['09:10', '16:00'], claimed: '08:00' });
    await t.accept();
    expect(t.saved().check_in_at).toEqual(at('08:00'));
  });
});
