import { AttendanceSource, LeaveRequestStatus, StaffAttendanceStatus, StaffRole } from '@prisma/client';
import { LeaveRequestsService } from './leave-requests.service';
import { LeaveAttendanceSyncService } from './leave-attendance-sync.service';

// TAFSD-462: approving sick leave, the admin chooses Paid or Unpaid. Unpaid
// days are UNPAID_LEAVE, which payroll deducts.

jest.mock('../../../common/auth/super-admin', () => ({ assertMayChangeEmployee: jest.fn(async () => undefined) }));

const admin = { sub: 'admin', role: StaffRole.SUPER_ADMIN } as any;

function buildReview(code: string, typeIsPaid = true) {
  const existing = {
    id: 1,
    employee_id: 5,
    status: LeaveRequestStatus.PENDING,
    start_date: new Date(Date.UTC(2026, 10, 10)),
    end_date: new Date(Date.UTC(2026, 10, 10)),
    created_at: new Date(),
    reason: null,
    leave_types: { id: 1, code, name: code, is_paid: typeIsPaid },
    employee_profiles: { campus_id: 1, full_name: 'T', employee_code: null },
  };
  const prisma = {
    leave_requests: {
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ data }: any) => ({ ...existing, ...data })),
    },
    employee_profiles: { findUnique: jest.fn(async () => ({ user_id: null })) },
  };
  const sync = { syncApprovedLeaveToAttendance: jest.fn(async () => 1) };
  const svc = new LeaveRequestsService(prisma as any, {} as any, sync as any, {} as any, { log: jest.fn() } as any, {} as any);
  (svc as any).getById = jest.fn(async () => existing);
  return { svc, prisma };
}

const savedIsPaid = (prisma: ReturnType<typeof buildReview>['prisma']) =>
  (prisma.leave_requests.update.mock.calls[0] as any[])[0].data.is_paid;

describe('approving sick leave', () => {
  it('requires a Paid or Unpaid choice', async () => {
    const { svc } = buildReview('SICK');
    await expect(svc.review(1, { status: LeaveRequestStatus.APPROVED }, admin)).rejects.toThrow('Paid or Unpaid');
  });

  it('stores the choice', async () => {
    const unpaid = buildReview('SICK');
    await unpaid.svc.review(1, { status: LeaveRequestStatus.APPROVED, isPaid: false }, admin);
    expect(savedIsPaid(unpaid.prisma)).toBe(false);

    const paid = buildReview('SICK');
    await paid.svc.review(1, { status: LeaveRequestStatus.APPROVED, isPaid: true }, admin);
    expect(savedIsPaid(paid.prisma)).toBe(true);
  });

  it('takes other types from the leave type, ignoring a choice', async () => {
    const { svc, prisma } = buildReview('UNPAID', false);
    await svc.review(1, { status: LeaveRequestStatus.APPROVED, isPaid: true }, admin);
    expect(savedIsPaid(prisma)).toBe(false);
  });

  it('clears it on rejection', async () => {
    const { svc, prisma } = buildReview('SICK');
    await svc.review(1, { status: LeaveRequestStatus.REJECTED, reviewReason: 'no' }, admin);
    expect(savedIsPaid(prisma)).toBeNull();
  });
});

describe('syncing approved sick leave to attendance', () => {
  async function statusFor(isPaid: boolean | null) {
    const upsert = jest.fn(async () => ({}));
    const prisma = {
      leave_requests: {
        findUnique: jest.fn(async () => ({
          id: 1,
          employee_id: 5,
          is_paid: isPaid,
          start_date: new Date(Date.UTC(2026, 10, 10)),
          end_date: new Date(Date.UTC(2026, 10, 10)),
          leave_types: { code: 'SICK' },
          employee_profiles: { id: 5, campus_id: 1 },
        })),
      },
      attendance_staff_daily: { findUnique: jest.fn(async () => null), upsert },
    };
    const resolver = { resolveStaffDay: jest.fn(async () => ({ isWorkingDay: true })) };
    await new LeaveAttendanceSyncService(prisma as any, resolver as any).syncApprovedLeaveToAttendance(1);
    const arg = (upsert.mock.calls[0] as any[])[0];
    expect(arg.create.source).toBe(AttendanceSource.LEAVE);
    return arg.create.status;
  }

  it('marks paid days SICK_LEAVE and unpaid days UNPAID_LEAVE', async () => {
    expect(await statusFor(true)).toBe(StaffAttendanceStatus.SICK_LEAVE);
    expect(await statusFor(false)).toBe(StaffAttendanceStatus.UNPAID_LEAVE);
    // Approved before the choice existed: paid, as sick leave always was.
    expect(await statusFor(null)).toBe(StaffAttendanceStatus.SICK_LEAVE);
  });
});
