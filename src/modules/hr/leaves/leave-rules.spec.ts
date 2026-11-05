import { EmploymentSubtype } from '@prisma/client';
import { LeaveRequestsService } from './leave-requests.service';

// TAFSD-461: Casual leave is for permanent staff only, and Annual leave is retired.

const TYPES = [
  { id: 1, code: 'SICK', name: 'Sick', is_paid: true },
  { id: 2, code: 'CASUAL', name: 'Casual', is_paid: true },
  { id: 3, code: 'ANNUAL', name: 'Annual', is_paid: true },
  { id: 4, code: 'UNPAID', name: 'Unpaid', is_paid: false },
];

function build(permanent: boolean) {
  const profile = {
    id: 5,
    full_name: 'Test',
    campus_id: 1,
    is_permanent_employee: permanent,
    employment_subtype: permanent ? EmploymentSubtype.PERMANENT : EmploymentSubtype.NON_PERMANENT,
    join_date: new Date(),
    departments: { name: 'Academics' },
  };
  const prisma = {
    employee_profiles: { findUnique: jest.fn(async () => profile) },
    leave_types: {
      findMany: jest.fn(async () => TYPES),
      findUnique: jest.fn(async ({ where }: any) => TYPES.find((t) => t.code === where.code) ?? null),
    },
    leave_requests: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({ id: 1 })) },
  };
  const svc = new LeaveRequestsService(prisma as any, {} as any, {} as any, {} as any, { log: jest.fn() } as any, {} as any);
  (svc as any).notifyApprovers = jest.fn(async () => undefined);
  return { svc, prisma };
}

const apply = (code: string) => ({ leaveTypeCode: code, startDate: '2026-11-10', endDate: '2026-11-10', reason: 'x' });

describe('leave types offered to the staff app', () => {
  it('never offers Annual, and offers Casual only to permanent staff', async () => {
    const codes = async (permanent: boolean) =>
      (await build(permanent).svc.getSelfContext('u')).leaveTypes.map((t) => t.code);
    expect(await codes(true)).toEqual(['SICK', 'CASUAL', 'UNPAID']);
    expect(await codes(false)).toEqual(['SICK', 'UNPAID']);
  });
});

describe('creating a leave request', () => {
  it('refuses Annual leave', async () => {
    await expect(build(true).svc.create('u', apply('ANNUAL'))).rejects.toThrow('no longer offered');
  });

  it('refuses Casual leave from non-permanent staff and accepts it from permanent staff', async () => {
    await expect(build(false).svc.create('u', apply('CASUAL'))).rejects.toThrow('Casual leave');
    const { svc, prisma } = build(true);
    await svc.create('u', apply('CASUAL'));
    expect(prisma.leave_requests.create).toHaveBeenCalled();
  });
});
