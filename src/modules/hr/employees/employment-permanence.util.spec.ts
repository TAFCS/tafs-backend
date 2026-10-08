import { EmployeeStatus, EmploymentSubtype } from '@prisma/client';
import { permanenceFields } from './employment-permanence.util';
import { PermanentEmployeeScheduler } from '../leaves/permanent-employee.scheduler';

/** TAFSD-275: the status × subtype matrix and the permanent flag that follows it. */
describe('permanenceFields', () => {
  it('ACTIVE + PERMANENT sets the permanent flag', () => {
    expect(permanenceFields(EmployeeStatus.ACTIVE, EmploymentSubtype.PERMANENT)).toEqual({
      employment_subtype: 'PERMANENT',
      is_permanent_employee: true,
    });
  });

  it('ACTIVE + NON_PERMANENT clears the flag', () => {
    expect(permanenceFields(EmployeeStatus.ACTIVE, EmploymentSubtype.NON_PERMANENT)).toEqual({
      employment_subtype: 'NON_PERMANENT',
      is_permanent_employee: false,
    });
  });

  it('ACTIVE with no subtype is unclassified and not permanent', () => {
    expect(permanenceFields(EmployeeStatus.ACTIVE, null)).toEqual({
      employment_subtype: null,
      is_permanent_employee: false,
    });
  });

  it.each([EmployeeStatus.LEFT, EmployeeStatus.TERMINATED])(
    '%s drops the subtype and leaves the flag as it was',
    (status) => {
      const fields = permanenceFields(status, EmploymentSubtype.PERMANENT);
      expect(fields).toEqual({ employment_subtype: null });
      expect('is_permanent_employee' in fields).toBe(false);
    },
  );
});

describe('PermanentEmployeeScheduler', () => {
  it('promotes ACTIVE staff with 14+ months to PERMANENT, setting both fields', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 3 });
    const scheduler = new PermanentEmployeeScheduler({ employee_profiles: { updateMany } } as any);

    const count = await scheduler.markPermanentEmployees(new Date('2026-10-09T10:00:00Z'));

    expect(count).toBe(3);
    const { where, data } = updateMany.mock.calls[0][0];
    expect(where.employment_status).toBe('ACTIVE');
    expect(where.join_date.lte.toISOString()).toBe('2025-08-09T00:00:00.000Z');
    expect(data).toEqual({ employment_subtype: 'PERMANENT', is_permanent_employee: true });
  });
});
