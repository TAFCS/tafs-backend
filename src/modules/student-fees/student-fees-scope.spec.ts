import { NotFoundException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { StudentFeesService } from './student-fees.service';
import { ScopeService } from '../../common/scope/scope.service';
import { EMPTY_SCOPE, type UserScope } from '../../common/scope/scope.types';

/**
 * Guards the two things scope must not get wrong on this page:
 *  - a user who was never scoped sees exactly what they saw before, and pays
 *    no extra query for the privilege;
 *  - a scoped user gets a 404 (not a 403, which would confirm the CC exists).
 *
 * getCautionFeeHistory is the smallest public method that runs the student
 * scope check, so it stands in for all of them.
 */
const CAUTION_ROWS = [{ id: 1, amount: '5000' }];

const build = (student: Record<string, unknown> | null) => {
  const studentsFindMany = jest.fn().mockResolvedValue(student ? [student] : []);
  const prisma: any = {
    students: { findMany: studentsFindMany },
    student_fees: { findMany: jest.fn().mockResolvedValue(CAUTION_ROWS) },
  };
  const service = new StudentFeesService(
    prisma,
    { log: jest.fn() } as any,
    {} as any,
    new ScopeService(prisma),
  );
  return { service, studentsFindMany };
};

const staff = (scope: Partial<UserScope> = {}, role: StaffRole = StaffRole.EMPLOYEE) =>
  ({ role, userType: 'STAFF', scope: { ...EMPTY_SCOPE, ...scope } }) as any;

const AT_CAMPUS_1 = { cc: 4051, campus_id: 1, class_id: 10, section_id: 100, classes: { segment_id: 2 } };

describe('student-fees student scope', () => {
  it('does not touch the students table for an unscoped user', async () => {
    const { service, studentsFindMany } = build(AT_CAMPUS_1);
    await expect(service.getCautionFeeHistory(4051, staff())).resolves.toEqual(CAUTION_ROWS);
    expect(studentsFindMany).not.toHaveBeenCalled();
  });

  it('does not touch the students table for SUPER_ADMIN', async () => {
    const { service, studentsFindMany } = build(AT_CAMPUS_1);
    await expect(
      service.getCautionFeeHistory(4051, staff({ campuses: [9] }, StaffRole.SUPER_ADMIN)),
    ).resolves.toEqual(CAUTION_ROWS);
    expect(studentsFindMany).not.toHaveBeenCalled();
  });

  it('lets a scoped user through for a student inside their scope', async () => {
    const { service } = build(AT_CAMPUS_1);
    await expect(
      service.getCautionFeeHistory(4051, staff({ campuses: [1] })),
    ).resolves.toEqual(CAUTION_ROWS);
  });

  it('404s — never 403s — for a student outside the scope', async () => {
    const { service } = build(AT_CAMPUS_1);
    await expect(
      service.getCautionFeeHistory(4051, staff({ campuses: [2] })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('applies class and segment, not just campus', async () => {
    const byClass = build(AT_CAMPUS_1);
    await expect(
      byClass.service.getCautionFeeHistory(4051, staff({ classes: [11] })),
    ).rejects.toBeInstanceOf(NotFoundException);

    const bySegment = build(AT_CAMPUS_1);
    await expect(
      bySegment.service.getCautionFeeHistory(4051, staff({ segments: [3] })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('leaves a nonexistent CC to the caller to report, not to scope', async () => {
    const { service } = build(null);
    await expect(
      service.getCautionFeeHistory(9999, staff({ campuses: [1] })),
    ).resolves.toEqual(CAUTION_ROWS);
  });
});
