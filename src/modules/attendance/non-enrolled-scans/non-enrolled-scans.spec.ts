import 'reflect-metadata';

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('@react-pdf/renderer', () => ({ renderToBuffer: jest.fn() }));

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Prisma, StaffRole, student_status } from '@prisma/client';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { REQUIRE_ACTION_KEY, type RequireActionMetadata } from '../../../decorators/require-action.decorator';
import { computeEffectiveAccess } from '../../access/access.effective';
import { MANIFEST_EFFECTIVE_TILES, TILES_MANIFEST } from '../../access/tiles.manifest';
import { ZkAttendanceProcessorService } from '../zk-attendance-processor.service';
import {
  NON_ENROLLED_ACTION,
  NON_ENROLLED_ALERT_KIND,
  NON_ENROLLED_FLAG_STATUSES,
  NON_ENROLLED_TILE_ID,
} from './non-enrolled-scan.constants';
import { NonEnrolledScansController } from './non-enrolled-scans.controller';
import { NonEnrolledScansService, alertText, type ScanToCheck } from './non-enrolled-scans.service';

/**
 * TAFSD-556: a scan by a student who is not enrolled is flagged beside the
 * normal processing, which it never changes, and the report is default-deny.
 */

const NOW = new Date('2026-11-22T04:00:00.000Z'); // 09:00 PKT
const TODAY = new Date('2026-11-22T00:00:00.000Z');

const scan = (over: Partial<ScanToCheck> = {}): ScanToCheck => ({
  id: 501,
  student_cc: 7518,
  device_sn: 'GEJ-01',
  device_pin: '7518',
  scan_time: new Date('2026-11-22T07:41:00.000Z'), // 07:41 naive PKT
  attendance_date: TODAY,
  ...over,
});

function makeService(opts: {
  status?: student_status;
  createCount?: number;
  alreadyAlerted?: number;
  createError?: unknown;
  holders?: string[];
  superAdmins?: string[];
  denied?: string[];
  visible?: boolean;
} = {}) {
  const prisma: any = {
    students: {
      findUnique: jest.fn().mockResolvedValue({
        status: opts.status ?? student_status.LEFT,
        campus_id: 1,
        full_name: 'Test Student',
        campuses: { campus_name: 'Gulistan-e-Johar Campus' },
      }),
      count: jest.fn().mockResolvedValue(opts.visible === false ? 0 : 1),
    },
    student_progression_periods: {
      findFirst: jest.fn().mockResolvedValue({ valid_from: new Date('2026-10-26T06:00:00.000Z') }),
    },
    attendance_non_enrolled_scans: {
      createMany: opts.createError
        ? jest.fn().mockRejectedValue(opts.createError)
        : jest.fn().mockResolvedValue({ count: opts.createCount ?? 1 }),
      count: jest.fn().mockResolvedValue(opts.alreadyAlerted ?? 0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user_tile_action_grants: {
      findMany: jest.fn().mockImplementation(({ where }: { where: { allow: boolean } }) =>
        Promise.resolve((where.allow ? opts.holders ?? ['u-1'] : opts.denied ?? []).map((user_id) => ({ user_id }))),
      ),
    },
    user_access_packs: { findMany: jest.fn().mockResolvedValue([]) },
    users: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve({ role: (opts.superAdmins ?? []).includes(where.id) ? StaffRole.SUPER_ADMIN : StaffRole.PRINCIPAL }),
      ),
      findMany: jest.fn().mockResolvedValue((opts.superAdmins ?? []).map((id) => ({ id }))),
    },
  };
  const scope: any = {
    resolveEffective: jest.fn().mockResolvedValue({}),
    whereForStudents: jest.fn().mockReturnValue({ campus_id: { in: [1] } }),
  };
  const access: any = {
    resolveLiveSession: jest.fn().mockResolvedValue({ isActive: true, actionIds: [NON_ENROLLED_ACTION.alerts] }),
  };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const service = new NonEnrolledScansService(prisma, scope, access, notifications);
  return { service, prisma, notifications, access };
}

describe('NonEnrolledScansService.flagScan', () => {
  it('counts LEFT, EXPELLED and GRADUATED as not enrolled, and nothing else', () => {
    expect([...NON_ENROLLED_FLAG_STATUSES].sort()).toEqual(['EXPELLED', 'GRADUATED', 'LEFT']);
  });

  it.each([student_status.ENROLLED, student_status.SOFT_ADMISSION, student_status.QUICK_ADMISSION])(
    'records nothing for a %s student',
    async (status) => {
      const { service, prisma, notifications } = makeService({ status });
      await expect(service.flagScan(scan(), NOW)).resolves.toBe('enrolled');
      expect(prisma.attendance_non_enrolled_scans.createMany).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
    },
  );

  it('flags a LEFT student with status, left date, campus and device, idempotently per scan', async () => {
    const { service, prisma } = makeService();
    await expect(service.flagScan(scan(), NOW)).resolves.toBe('flagged');
    const call = prisma.attendance_non_enrolled_scans.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data[0]).toEqual({
      scan_id: 501,
      student_cc: 7518,
      student_status: 'LEFT',
      left_at: new Date('2026-10-26T06:00:00.000Z'),
      campus_id: 1,
      device_sn: 'GEJ-01',
      device_pin: '7518',
      scan_time: scan().scan_time,
      attendance_date: TODAY,
    });
  });

  it('alerts the holders who can see the student, once', async () => {
    const { service, prisma, notifications } = makeService();
    await service.flagScan(scan(), NOW);
    expect(prisma.attendance_non_enrolled_scans.updateMany).toHaveBeenCalledWith({
      where: { scan_id: 501, alerted_at: null },
      data: { alerted_at: NOW },
    });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const [userId, input] = notifications.notify.mock.calls[0];
    expect(userId).toBe('u-1');
    expect(input.kind).toBe(NON_ENROLLED_ALERT_KIND);
    expect(input.link).toBe('/attendance/non-enrolled-check-ins?from=2026-11-22&to=2026-11-22');
    expect(input.body).toBe(
      'Test Student (C.C. 7518) is marked left since 2026-10-26 but scanned in at Gulistan-e-Johar Campus at 07:41.',
    );
  });

  it('does not alert again for the same student and day', async () => {
    const { service, prisma, notifications } = makeService({ alreadyAlerted: 1 });
    await expect(service.flagScan(scan(), NOW)).resolves.toBe('flagged');
    expect(prisma.attendance_non_enrolled_scans.updateMany).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('loses a race for the day quietly (the partial unique index refuses the second claim)', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.attendance_non_enrolled_scans.updateMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(service.flagScan(scan(), NOW)).resolves.toBe('flagged');
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('skips holders outside the student’s campus', async () => {
    const { service, notifications } = makeService({ visible: false });
    await service.flagScan(scan(), NOW);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('skips a holder whose alerts action is denied or whose login is off', async () => {
    const { service, access, notifications } = makeService();
    access.resolveLiveSession.mockResolvedValue({ isActive: true, actionIds: [NON_ENROLLED_ACTION.view] });
    await service.flagScan(scan(), NOW);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('alerts every active super admin without a tick, whatever their scope', async () => {
    const { service, prisma, notifications, access } = makeService({ holders: [], superAdmins: ['sa-1', 'sa-2'], visible: false });
    await service.flagScan(scan(), NOW);
    expect(prisma.users.findMany).toHaveBeenCalledWith({ where: { role: StaffRole.SUPER_ADMIN, is_active: true }, select: { id: true } });
    expect(notifications.notify.mock.calls.map((c: unknown[]) => c[0]).sort()).toEqual(['sa-1', 'sa-2']);
    // A super admin is not looked up as an ordinary holder.
    expect(access.resolveLiveSession).not.toHaveBeenCalled();
  });

  it('a super admin with an explicit deny on alerts gets none', async () => {
    const { service, notifications } = makeService({ holders: [], superAdmins: ['sa-1', 'sa-2'], denied: ['sa-2'] });
    await service.flagScan(scan(), NOW);
    expect(notifications.notify.mock.calls.map((c: unknown[]) => c[0])).toEqual(['sa-1']);
  });

  it('a super admin who also has the tick is alerted once', async () => {
    const { service, notifications } = makeService({ holders: ['sa-1', 'u-1'], superAdmins: ['sa-1'] });
    await service.flagScan(scan(), NOW);
    expect(notifications.notify.mock.calls.map((c: unknown[]) => c[0]).sort()).toEqual(['sa-1', 'u-1']);
  });

  it('flags but does not alert for a past day replayed by a device catching up', async () => {
    const { service, prisma, notifications } = makeService();
    await expect(
      service.flagScan(scan({ attendance_date: new Date('2026-11-20T00:00:00.000Z') }), NOW),
    ).resolves.toBe('flagged');
    expect(prisma.attendance_non_enrolled_scans.createMany).toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('sends nothing when the scan was already flagged (reprocessing)', async () => {
    const { service, notifications } = makeService({ createCount: 0 });
    await expect(service.flagScan(scan(), NOW)).resolves.toBe('already_flagged');
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('never throws while the table does not exist yet', async () => {
    const { service } = makeService({
      createError: new Prisma.PrismaClientKnownRequestError('missing', { code: 'P2021', clientVersion: 'x' }),
    });
    await expect(service.flagScan(scan(), NOW)).resolves.toBe('table_missing');
  });

  it('never throws on any other failure', async () => {
    const { service } = makeService({ createError: new Error('connection reset') });
    await expect(service.flagScan(scan(), NOW)).resolves.toBe('failed');
  });

  it('words the alert without a left date when none is recorded', () => {
    expect(
      alertText({ fullName: null, cc: 9, status: student_status.EXPELLED, leftOn: null, campusName: null, time: '08:05' }).body,
    ).toBe('A student (C.C. 9) is marked expelled but scanned in at 08:05.');
  });
});

describe('NonEnrolledScansService.report: split by segment, limited by scope', () => {
  const flag = (cc: number, date: string, segment: { id: number; name: string } | null, time = '07:40') => ({
    student_cc: cc,
    student_status: student_status.LEFT,
    left_at: null,
    campus_id: 1,
    device_sn: 'GEJ-01',
    device_pin: String(cc),
    scan_time: new Date(`${date}T${time}:00.000Z`),
    attendance_date: new Date(`${date}T00:00:00.000Z`),
    campuses: { campus_name: 'Gulistan-e-Johar Campus' },
    students: {
      full_name: `Student ${cc}`,
      gr_number: null,
      status: student_status.LEFT,
      classes: { class_code: 'EY-I', segment_id: segment?.id ?? null, segments: segment ? { name: segment.name } : null },
    },
  });
  const EY = { id: 1, name: 'Early Years' };
  const JR = { id: 2, name: 'Junior' };

  function reportService(flags: unknown[]) {
    const { service, prisma } = makeService();
    prisma.attendance_non_enrolled_scans.findMany = jest.fn().mockResolvedValue(flags);
    const scope: any = (service as any).scope;
    scope.whereForStudents.mockReturnValue({ classes: { segment_id: { in: [1] } } });
    return { service, prisma, scope };
  }
  const user = { id: 'u-1', role: StaffRole.PRINCIPAL } as any;

  it("applies the caller's scope and narrows by the segment filter", async () => {
    const { service, prisma } = reportService([]);
    await service.report({ from: '2026-11-20', to: '2026-11-22', segment_ids: [1, 2] }, user);
    const where = prisma.attendance_non_enrolled_scans.findMany.mock.calls[0][0].where;
    expect(where.students.is.AND).toEqual([
      { classes: { segment_id: { in: [1] } } },
      {},
      { classes: { is: { segment_id: { in: [1, 2] } } } },
    ]);
  });

  it('no segment filter adds nothing beyond scope', async () => {
    const { service, prisma } = reportService([]);
    await service.report({ from: '2026-11-22' }, user);
    const where = prisma.attendance_non_enrolled_scans.findMany.mock.calls[0][0].where;
    expect(where.students.is.AND).toHaveLength(2);
  });

  it('returns the segment on each row and a per-segment count', async () => {
    const { service } = reportService([
      flag(10, '2026-11-22', EY),
      flag(10, '2026-11-22', EY, '08:00'),
      flag(10, '2026-11-21', EY),
      flag(11, '2026-11-22', JR),
      flag(12, '2026-11-22', null),
    ]);
    const out = await service.report({ from: '2026-11-21', to: '2026-11-22' }, user);
    expect(out.rows.find((r) => r.student_cc === 11)).toMatchObject({ segment_id: 2, segment_name: 'Junior' });
    expect(out.by_segment).toEqual([
      { segment_id: 1, segment_name: 'Early Years', students: 1, days: 2 },
      { segment_id: 2, segment_name: 'Junior', students: 1, days: 1 },
      { segment_id: null, segment_name: null, students: 1, days: 1 },
    ]);
  });
});

describe('ZkAttendanceProcessorService: the scan is processed exactly as before', () => {
  afterEach(() => jest.restoreAllMocks());

  function makeProcessor(flagScan: jest.Mock | null) {
    const prisma: any = {
      device_user_mappings: {
        findUnique: jest.fn().mockResolvedValue({ person_type: 'STUDENT', student_cc: 7518, employee_id: null, is_active: true }),
      },
      zk_attendance_scans: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 501, ...data })),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const coral9 = { forward: jest.fn() };
    const nonEnrolled = flagScan ? ({ flagScan } as any) : undefined;
    const processor = new ZkAttendanceProcessorService(
      prisma, null as any, null as any, null as any, null as any, null as any, null as any, coral9 as any, nonEnrolled,
    );
    const seg = { checkInAt: null, checkOutAt: null, lastScanAt: null, scanCount: 1, lastDirection: 'IN', announceLast: true, checkOutOnly: false };
    const recompute = jest.spyOn(processor, 'recomputeDaySequence').mockResolvedValue(seg as any);
    const upsert = jest.spyOn(processor, 'upsertStudentDaily').mockResolvedValue('IN' as any);
    const notify = jest.spyOn(processor as any, 'sendScanNotification').mockResolvedValue(true);
    const run = () =>
      (processor as any).processOneScan({
        sn: 'GEJ-01',
        pin: '7518',
        scanTime: new Date('2026-11-22T08:58:00.000Z'), // live: two minutes before NOW in naive PKT
        pushLogId: null,
        now: NOW,
      });
    return { run, recompute, upsert, notify, prisma };
  }

  it('flags the student scan, then still marks the day and tells the parent', async () => {
    const flagScan = jest.fn().mockResolvedValue('flagged');
    const { run, upsert, notify } = makeProcessor(flagScan);
    await expect(run()).resolves.toEqual({ scanId: 501, notified: true });
    expect(flagScan).toHaveBeenCalledWith(expect.objectContaining({ id: 501, student_cc: 7518, device_sn: 'GEJ-01' }));
    expect(upsert).toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
  });

  it('an enrolled student is processed the same way (the check records nothing)', async () => {
    const flagScan = jest.fn().mockResolvedValue('enrolled');
    const { run, upsert, notify } = makeProcessor(flagScan);
    await expect(run()).resolves.toEqual({ scanId: 501, notified: true });
    expect(upsert).toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
  });

  it('a failure while flagging never stops the scan being processed', async () => {
    const flagScan = jest.fn().mockRejectedValue(new Error('boom'));
    const { run, upsert, notify } = makeProcessor(flagScan);
    await expect(run()).resolves.toEqual({ scanId: 501, notified: true });
    expect(upsert).toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
  });

  it('does not check staff scans or double-taps', async () => {
    const flagScan = jest.fn();
    const staff = makeProcessor(flagScan);
    staff.prisma.device_user_mappings.findUnique.mockResolvedValue({ person_type: 'STAFF', employee_id: 4, student_cc: null, is_active: true });
    jest.spyOn(ZkAttendanceProcessorService.prototype, 'upsertStaffDaily').mockResolvedValue(undefined as any);
    jest.spyOn(ZkAttendanceProcessorService.prototype as any, 'sendStaffScanNotification').mockResolvedValue(false);
    await staff.run();

    const dup = makeProcessor(flagScan);
    dup.prisma.zk_attendance_scans.findFirst.mockResolvedValue({ scan_time: new Date('2026-11-22T08:57:30.000Z') });
    await dup.run();

    expect(flagScan).not.toHaveBeenCalled();
  });
});

// ── Permission gate ─────────────────────────────────────────────────────────

const allKeys = [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))];

function userWith(opts: { role?: StaffRole; allowTileIds?: string[]; actionGrants?: string[] } = {}) {
  const r = computeEffectiveAccess({
    role: opts.role ?? StaffRole.PRINCIPAL,
    allPermissionKeys: allKeys,
    activeTiles: MANIFEST_EFFECTIVE_TILES,
    // Every capability a role could carry: the tile must still need a per-person tick.
    roleKeys: opts.role === StaffRole.SUPER_ADMIN ? [] : allKeys,
    packTileIds: [],
    allowTileIds: opts.allowTileIds ?? [],
    denyTileIds: [],
    userPerms: [],
    userActionGrants: (opts.actionGrants ?? []).map((actionId) => ({ tileId: NON_ENROLLED_TILE_ID, actionId, allow: true })),
  });
  return { role: opts.role ?? StaffRole.PRINCIPAL, userType: 'STAFF', permissions: r.capabilityKeys, actions: r.actionIds };
}

function routeAllows(handler: keyof NonEnrolledScansController, user: unknown): boolean {
  const meta = Reflect.getMetadata(REQUIRE_ACTION_KEY, NonEnrolledScansController.prototype[handler]) as RequireActionMetadata;
  const reflector = { getAllAndOverride: () => meta } as unknown as Reflector;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  try {
    return new TileActionGuard(reflector).canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

describe('Not Enrolled Check-ins tile is default-deny', () => {
  it('is a web tile with no legacy capability bridging into it', () => {
    const tile = TILES_MANIFEST.find((t) => t.id === NON_ENROLLED_TILE_ID)!;
    expect(tile).toBeDefined();
    expect(tile.surface ?? 'web').toBe('web');
    expect(tile.legacyFullAccessCapabilities ?? []).toEqual([]);
    expect(tile.actions!.map((a) => a.id).sort()).toEqual(['alerts', 'export', 'view']);
    expect(tile.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
  });

  it('every route runs TileActionGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, NonEnrolledScansController)).toContain(TileActionGuard);
  });

  it('refuses a user holding every capability but no tick on the tile', () => {
    const user = userWith();
    expect(routeAllows('report', user)).toBe(false);
    expect(routeAllows('export', user)).toBe(false);
  });

  it('the tile alone opens the report but neither exports nor alerts', () => {
    const user = userWith({ allowTileIds: [NON_ENROLLED_TILE_ID] });
    expect(routeAllows('report', user)).toBe(true);
    expect(routeAllows('export', user)).toBe(false);
    expect(user.actions).not.toContain(NON_ENROLLED_ACTION.alerts);
  });

  it('export and alerts are their own ticks', () => {
    const user = userWith({ allowTileIds: [NON_ENROLLED_TILE_ID], actionGrants: ['export', 'alerts'] });
    expect(routeAllows('export', user)).toBe(true);
    expect(user.actions).toContain(NON_ENROLLED_ACTION.alerts);
  });

  it('a SUPER_ADMIN can open it', () => {
    expect(routeAllows('report', userWith({ role: StaffRole.SUPER_ADMIN }))).toBe(true);
  });
});
