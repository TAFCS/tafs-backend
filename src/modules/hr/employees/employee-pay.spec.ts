import { Prisma } from '@prisma/client';
import { EmployeePayService } from './employee-pay.service';
import { pktDayStart } from './employee-timings.service';

// TAFSD-372: monthly pay changes effective from a date.

const dims = { employee_id: 9, campus_id: 1, segment_id: null, department_id: 1, staff_category_id: 1, reporting_manager_id: null, job_title: 'T', employment_type: null, employment_status: 'ACTIVE', payroll_enabled: true, class_sections: [], timings: null };
const history = () => [
  { id: 1, ...dims, valid_from: new Date('2026-07-26T00:00:00Z'), valid_to: new Date('2026-10-13T00:00:00Z'), change_type: 'ONBOARDED', monthly_pay: new Prisma.Decimal(40000) },
  { id: 2, ...dims, valid_from: new Date('2026-10-13T00:00:00Z'), valid_to: null, change_type: 'REASSIGNED', monthly_pay: new Prisma.Decimal(40000) },
];

function build(periods: any[]) {
  const created: any[] = [];
  const updated: any[] = [];
  const tx = {
    employee_progression_periods: {
      findMany: jest.fn(async () => periods),
      update: jest.fn(async (a: any) => updated.push(a)),
      create: jest.fn(async (a: any) => created.push(a.data)),
    },
    employee_profiles: { update: jest.fn(async () => ({})), findUnique: jest.fn() },
  };
  return { svc: new EmployeePayService({} as any, { log: jest.fn() } as any), tx, created, updated };
}

describe('EmployeePayService.applyInTx', () => {
  it('back-dated: splits at PKT midnight, carries the new pay forward and updates the profile', async () => {
    const { svc, tx, created, updated } = build(history());
    const r = await svc.applyInTx(tx as any, 9, '45000.00', '2026-10-01', 'aawaiz', new Date('2026-10-17T02:00:00Z'), null);
    expect(r).toEqual({ status: 'APPLIED', previous: '40000.00' });
    expect(updated[0]).toEqual({ where: { id: 1 }, data: { valid_to: pktDayStart('2026-10-01') } });
    expect(created[0]).toMatchObject({ change_type: 'PAY_CHANGED', monthly_pay: '45000.00', valid_from: pktDayStart('2026-10-01'), notes: 'Pay 40,000 → 45,000' });
    expect(updated.find((u) => u.where.id === 2)?.data).toEqual({ monthly_pay: '45000.00' });
    expect(tx.employee_profiles.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { monthly_pay: '45000.00' } });
  });

  it('refuses a back-date across a later pay change (e.g. a salary increment)', async () => {
    const h = history();
    h[1].monthly_pay = new Prisma.Decimal(42000);
    h[1].change_type = 'SALARY_INCREMENT';
    const { svc, tx } = build(h);
    await expect(svc.applyInTx(tx as any, 9, '45000.00', '2026-10-01', 'x', new Date(), null)).rejects.toThrow(/salary increment/);
  });
});

describe('EmployeePayService.changePay (future)', () => {
  it('schedules a future change without touching the profile', async () => {
    const upsert = jest.fn(async () => ({}));
    const prisma = {
      employee_profiles: { findUnique: jest.fn(async () => ({ full_name: 'X', monthly_pay: new Prisma.Decimal(40000) })) },
      employee_scheduled_pay_changes: { upsert },
      $transaction: jest.fn(),
    };
    const svc = new EmployeePayService(prisma as any, { log: jest.fn() } as any);
    const r = await svc.changePay(9, { monthly_pay: 45000, effective_from: '2099-01-01' }, 'aawaiz');
    expect(r.status).toBe('SCHEDULED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect((upsert.mock.calls[0] as any)[0].create.monthly_pay).toBe('45000.00');
  });
});
