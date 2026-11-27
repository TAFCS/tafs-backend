import { EmploymentSubtype, LeaveRequestStatus, StaffRole } from '@prisma/client';
import { LeaveRequestsService } from './leave-requests.service';

// TAFSD-621 (Mirza, #bugs 12): casual leave is one day only, strictly for
// permanent staff, and at most once per calendar month. Pending and approved
// requests count toward the month when applying; only approved ones when HR
// approves. Rejected, revoked and cancelled requests never count.

jest.mock('../../../common/auth/super-admin', () => ({ assertMayChangeEmployee: jest.fn(async () => undefined) }));

const TYPES = [
  { id: 1, code: 'SICK', name: 'Sick', is_paid: true },
  { id: 2, code: 'CASUAL', name: 'Casual', is_paid: true },
  { id: 4, code: 'UNPAID', name: 'Unpaid', is_paid: false },
];
const d = (s: string) => new Date(`${s}T00:00:00Z`);

type Row = { id: number; employee_id: number; leave_type_id: number; start_date: Date; end_date: Date; status: LeaveRequestStatus };

/** Just enough of Prisma's where for the leave service's queries. */
function matches(r: Row, w: any): boolean {
  if (w.employee_id !== undefined && (typeof w.employee_id === 'object' ? !w.employee_id.in.includes(r.employee_id) : w.employee_id !== r.employee_id)) return false;
  if (w.leave_type_id !== undefined && (typeof w.leave_type_id === 'object' ? !w.leave_type_id.in.includes(r.leave_type_id) : w.leave_type_id !== r.leave_type_id)) return false;
  if (w.status?.in && !w.status.in.includes(r.status)) return false;
  if (w.start_date?.lte && r.start_date > w.start_date.lte) return false;
  if (w.end_date?.gte && r.end_date < w.end_date.gte) return false;
  if (w.id?.not !== undefined && r.id === w.id.not) return false;
  return true;
}

function build(subtype: EmploymentSubtype, existing: Omit<Row, 'employee_id'>[] = [], joinDate = d('2015-01-01')) {
  const profile = {
    id: 5,
    full_name: 'Test',
    campus_id: 1,
    is_permanent_employee: subtype === EmploymentSubtype.PERMANENT,
    employment_subtype: subtype,
    join_date: joinDate,
    departments: { name: 'ACADEMICS' },
  };
  const rows: Row[] = existing.map((r) => ({ ...r, employee_id: 5 }));
  const prisma = {
    employee_profiles: { findUnique: jest.fn(async () => profile) },
    leave_types: {
      findMany: jest.fn(async () => TYPES),
      findUnique: jest.fn(async ({ where }: any) => TYPES.find((t) => t.code === where.code) ?? null),
    },
    leave_requests: {
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
      findMany: jest.fn(async ({ where, take }: any) => {
        const found = rows.filter((r) => matches(r, where)).sort((a, b) => +a.start_date - +b.start_date);
        return take ? found.slice(0, take) : found;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 100 + rows.length, status: LeaveRequestStatus.PENDING, ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => ({ ...rows.find((r) => r.id === where.id), ...data })),
    },
  };
  const sync = { syncApprovedLeaveToAttendance: jest.fn(async () => 1) };
  const svc = new LeaveRequestsService(prisma as any, {} as any, sync as any, {} as any, { log: jest.fn() } as any, {} as any, {} as any);
  (svc as any).notifyApprovers = jest.fn(async () => undefined);
  (svc as any).notifyEmployeeReview = jest.fn(async () => undefined);
  return { svc, prisma, rows, profile };
}

const casual = (startDate: string, endDate = startDate) => ({ leaveTypeCode: 'CASUAL', startDate, endDate });
const casualRow = (id: number, date: string, status: LeaveRequestStatus, end = date) => ({
  id, leave_type_id: 2, start_date: d(date), end_date: d(end), status,
});

describe('casual leave is one day only', () => {
  it('refuses a range and accepts a single date', async () => {
    const { svc, prisma } = build(EmploymentSubtype.PERMANENT);
    await expect(svc.create('u', casual('2026-12-08', '2026-12-09'))).rejects.toThrow('one day only');
    expect(prisma.leave_requests.create).not.toHaveBeenCalled();
    await svc.create('u', casual('2026-12-08'));
    expect(prisma.leave_requests.create).toHaveBeenCalledTimes(1);
  });

  it('leaves sick and unpaid leave free to span several days', async () => {
    const { svc, prisma } = build(EmploymentSubtype.NON_PERMANENT);
    await svc.create('u', { leaveTypeCode: 'UNPAID', startDate: '2026-12-08', endDate: '2026-12-12', reason: 'travel' });
    expect(prisma.leave_requests.create).toHaveBeenCalledTimes(1);
  });

  it('tells the app the type is single-day', async () => {
    const { svc } = build(EmploymentSubtype.PERMANENT);
    const ctx = await svc.getSelfContext('u');
    const byCode = Object.fromEntries(ctx.leaveTypes.map((t) => [t.code, t]));
    expect(byCode.CASUAL).toMatchObject({ single_day: true, max_per_month: 1, permanent_only: true });
    expect(byCode.SICK).toMatchObject({ single_day: false, max_per_month: null });
  });
});

describe('casual leave is for permanent staff only', () => {
  it('refuses staff marked NON_PERMANENT even after years of service, and CONTRACTUAL staff', async () => {
    // Joined 2015: the old rule counted 12/14 months of service as permanent.
    await expect(build(EmploymentSubtype.NON_PERMANENT).svc.create('u', casual('2026-12-08'))).rejects.toThrow(
      'only for permanent staff',
    );
    await expect(build(EmploymentSubtype.CONTRACTUAL).svc.create('u', casual('2026-12-08'))).rejects.toThrow('on contract');
  });

  it('does not offer Casual to them in the app', async () => {
    const ctx = await build(EmploymentSubtype.NON_PERMANENT).svc.getSelfContext('u');
    expect(ctx.isPermanentEmployee).toBe(false);
    expect(ctx.leaveTypes.map((t) => t.code)).toEqual(['SICK', 'UNPAID']);
  });

  it('accepts staff marked PERMANENT, however recently they joined', async () => {
    const { svc, prisma } = build(EmploymentSubtype.PERMANENT, [], d('2026-11-01'));
    await svc.create('u', casual('2026-12-08'));
    expect(prisma.leave_requests.create).toHaveBeenCalled();
  });
});

describe('casual leave at most once per calendar month', () => {
  it('refuses a second request in the month while the first is pending or approved', async () => {
    for (const status of [LeaveRequestStatus.PENDING, LeaveRequestStatus.APPROVED]) {
      const { svc, prisma } = build(EmploymentSubtype.PERMANENT, [casualRow(1, '2026-11-03', status)]);
      await expect(svc.create('u', casual('2026-11-24'))).rejects.toThrow(
        `once a month. You already have ${status === LeaveRequestStatus.PENDING ? 'a pending' : 'an approved'} casual leave on 2026-11-03 in November 2026`,
      );
      expect(prisma.leave_requests.create).not.toHaveBeenCalled();
    }
  });

  it('ignores rejected (and revoked) requests', async () => {
    const { svc, prisma } = build(EmploymentSubtype.PERMANENT, [casualRow(1, '2026-11-03', LeaveRequestStatus.REJECTED)]);
    await svc.create('u', casual('2026-11-24'));
    expect(prisma.leave_requests.create).toHaveBeenCalled();
  });

  it('counts calendar months: the 30th of one month does not block the 1st of the next', async () => {
    const { svc, prisma } = build(EmploymentSubtype.PERMANENT, [casualRow(1, '2026-11-30', LeaveRequestStatus.APPROVED)]);
    await svc.create('u', casual('2026-12-01'));
    expect(prisma.leave_requests.create).toHaveBeenCalledTimes(1);
    // ...and the December one now blocks the rest of December, across the year end too.
    await expect(svc.create('u', casual('2026-12-31'))).rejects.toThrow('December 2026');
    await svc.create('u', casual('2027-01-01'));
    expect(prisma.leave_requests.create).toHaveBeenCalledTimes(2);
  });

  it('does not count other leave types', async () => {
    const sick = { id: 1, leave_type_id: 1, start_date: d('2026-11-03'), end_date: d('2026-11-03'), status: LeaveRequestStatus.APPROVED };
    const { svc, prisma } = build(EmploymentSubtype.PERMANENT, [sick]);
    await svc.create('u', casual('2026-11-24'));
    expect(prisma.leave_requests.create).toHaveBeenCalled();
  });

  it('tells the app which months are already used', async () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const { svc } = build(EmploymentSubtype.PERMANENT, [casualRow(1, `${thisMonth}-01`, LeaveRequestStatus.PENDING)]);
    const ctx = await svc.getSelfContext('u');
    expect(ctx.leaveTypes.find((t) => t.code === 'CASUAL')!.months_at_limit).toEqual([thisMonth]);
  });
});

describe('approving casual leave checks the rules again', () => {
  const admin = { sub: 'admin', role: StaffRole.SUPER_ADMIN } as any;
  const reviewFor = (subtype: EmploymentSubtype, target: ReturnType<typeof casualRow>, others: ReturnType<typeof casualRow>[] = []) => {
    const b = build(subtype, [target, ...others]);
    (b.svc as any).getById = jest.fn(async () => ({
      ...target,
      employee_id: 5,
      created_at: new Date(),
      reason: null,
      leave_types: TYPES[1],
      employee_profiles: { ...b.profile, employee_code: null, campuses: null },
    }));
    return b;
  };
  const approve = (svc: LeaveRequestsService) => svc.review(10, { status: LeaveRequestStatus.APPROVED }, admin);

  it('refuses a second approval in the same month, but another pending one does not block', async () => {
    const pendingPair = reviewFor(EmploymentSubtype.PERMANENT, casualRow(10, '2026-11-20', LeaveRequestStatus.PENDING), [
      casualRow(11, '2026-11-05', LeaveRequestStatus.PENDING),
    ]);
    await approve(pendingPair.svc);
    expect(pendingPair.prisma.leave_requests.update).toHaveBeenCalled();

    const afterApproved = reviewFor(EmploymentSubtype.PERMANENT, casualRow(10, '2026-11-20', LeaveRequestStatus.PENDING), [
      casualRow(11, '2026-11-05', LeaveRequestStatus.APPROVED),
    ]);
    await expect(approve(afterApproved.svc)).rejects.toThrow('This employee already has an approved casual leave on 2026-11-05');
    expect(afterApproved.prisma.leave_requests.update).not.toHaveBeenCalled();
  });

  it('refuses an old multi-day request and one from staff not marked permanent', async () => {
    await expect(
      approve(reviewFor(EmploymentSubtype.PERMANENT, casualRow(10, '2026-11-20', LeaveRequestStatus.PENDING, '2026-11-21')).svc),
    ).rejects.toThrow('one day only');
    await expect(
      approve(reviewFor(EmploymentSubtype.NON_PERMANENT, casualRow(10, '2026-11-20', LeaveRequestStatus.PENDING)).svc),
    ).rejects.toThrow('This employee is not marked permanent');
  });

  it('flags the broken rules on the review list', async () => {
    const { svc, rows, profile } = build(EmploymentSubtype.NON_PERMANENT, [
      casualRow(10, '2026-11-20', LeaveRequestStatus.PENDING, '2026-11-21'),
      casualRow(11, '2026-11-05', LeaveRequestStatus.APPROVED),
    ]);
    const shaped = rows.map((r) => ({ ...r, leave_types: TYPES[1], employee_profiles: { ...profile, employee_code: null, campuses: null } }));
    const [pending, approved] = await svc.withRuleIssues(shaped as any);
    expect(pending.rule_issues).toHaveLength(3);
    expect(pending.rule_issues.join(' ')).toContain('2026-11-05 (approved)');
    expect(approved.rule_issues).toEqual([]);
  });
});
