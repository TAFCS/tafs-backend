import { EmployeeStatus, EmploymentSubtype } from '@prisma/client';
import { isPermanentForLeave, monthsUntilPermanent, permanenceFields } from './employment-permanence.util';
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

describe('monthsUntilPermanent (TAFSD-442)', () => {
  it('Academics (teachers) 14, everyone else 12', () => {
    expect(monthsUntilPermanent('ACADEMICS')).toBe(14);
    expect(monthsUntilPermanent('Support Services')).toBe(12);
    expect(monthsUntilPermanent('ADMINISTRATION')).toBe(12);
    expect(monthsUntilPermanent('SOMETHING NEW')).toBe(12);
    expect(monthsUntilPermanent(null)).toBe(12);
  });
});

describe('isPermanentForLeave (TAFSD-321)', () => {
  const now = new Date('2026-10-14T10:00:00Z');
  const base = { is_permanent_employee: false, employment_subtype: EmploymentSubtype.NON_PERMANENT };

  it('Academics needs 14 months: a teacher who joined 28 Aug 2025 is permanent from 28 Oct 2026', () => {
    expect(isPermanentForLeave({ ...base, join_date: new Date('2025-08-28'), departmentName: 'ACADEMICS' }, new Date('2026-10-27T10:00:00Z'))).toBe(false);
    expect(isPermanentForLeave({ ...base, join_date: new Date('2025-08-28'), departmentName: 'ACADEMICS' }, new Date('2026-10-28T10:00:00Z'))).toBe(true);
  });

  it('everyone else: permanent at 12 months, not at 11', () => {
    expect(isPermanentForLeave({ ...base, join_date: new Date('2025-10-14'), departmentName: 'ADMINISTRATION' }, now)).toBe(true);
    expect(isPermanentForLeave({ ...base, join_date: new Date('2025-11-14'), departmentName: 'SUPPORT SERVICES' }, now)).toBe(false);
  });

  it('contractual is never permanent, whatever the service or flag', () => {
    expect(
      isPermanentForLeave(
        { is_permanent_employee: true, employment_subtype: EmploymentSubtype.CONTRACTUAL, join_date: new Date('2010-01-01'), departmentName: 'ACADEMICS' },
        now,
      ),
    ).toBe(false);
  });

  it('the permanent flag wins for everyone else; no joining date is not permanent', () => {
    expect(isPermanentForLeave({ ...base, is_permanent_employee: true, join_date: null, departmentName: 'ACADEMICS' }, now)).toBe(true);
    expect(isPermanentForLeave({ ...base, join_date: null, departmentName: 'ACADEMICS' }, now)).toBe(false);
  });
});

describe('PermanentEmployeeScheduler (TAFSD-321)', () => {
  const departments = [
    { id: 6, name: 'ACADEMICS' },
    { id: 10, name: 'ADMINISTRATION' },
    { id: 11, name: 'SUPPORT SERVICES' },
  ];
  const run = async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const findMany = jest.fn().mockResolvedValue(departments);
    const scheduler = new PermanentEmployeeScheduler({ employee_profiles: { updateMany }, departments: { findMany } } as any);
    const count = await scheduler.markPermanentEmployees(new Date('2026-10-14T10:00:00Z'));
    const calls = updateMany.mock.calls.map((c) => c[0]);
    return { count, calls: calls.slice(0, -1), classify: calls[calls.length - 1] };
  };

  it('one update per period: 14 months for Academics, 12 for everyone else and no department', async () => {
    const { count, calls } = await run();
    expect(count).toBe(4);
    const byCutoff = Object.fromEntries(calls.map((c) => [c.where.join_date.lte.toISOString().slice(0, 10), c.where.AND[0]]));
    expect(byCutoff['2025-08-14']).toEqual({ department_id: { in: [6] } });
    expect(byCutoff['2025-10-14']).toEqual({ OR: [{ department_id: null }, { department_id: { in: [10, 11] } }] });
  });

  it('promote-only, never touches CONTRACTUAL, only ACTIVE staff', async () => {
    const { calls } = await run();
    for (const { where, data } of calls) {
      expect(where.employment_status).toBe('ACTIVE');
      expect(data).toEqual({ employment_subtype: 'PERMANENT', is_permanent_employee: true });
      const eligible = where.AND[1].OR;
      expect(eligible).toContainEqual({ employment_subtype: null });
      expect(eligible).toContainEqual({ employment_subtype: 'NON_PERMANENT' });
      expect(JSON.stringify(eligible)).not.toContain('CONTRACTUAL');
    }
  });

  it('then marks anyone still unclassified NON_PERMANENT (TAFSD-376)', async () => {
    const { classify } = await run();
    expect(classify).toEqual({
      where: { employment_status: 'ACTIVE', employment_subtype: null },
      data: { employment_subtype: 'NON_PERMANENT', is_permanent_employee: false },
    });
  });
});
