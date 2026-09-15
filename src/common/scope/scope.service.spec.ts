import { StaffRole } from '@prisma/client';
import { ScopeService } from './scope.service';
import { EMPTY_SCOPE, type UserScope } from './scope.types';

const service = new ScopeService({} as any);

const staff = (scope: Partial<UserScope> = {}, role: StaffRole = StaffRole.EMPLOYEE) =>
  ({ role, scope: { ...EMPTY_SCOPE, ...scope } }) as any;

const student = (over: Partial<Record<'campus_id' | 'class_id' | 'section_id' | 'segment_id', number | null>> = {}) => ({
  campus_id: 1,
  class_id: 10,
  section_id: 100,
  segment_id: 5,
  ...over,
});

describe('ScopeService.canSeeStudent', () => {
  it('lets an unscoped user see every student', () => {
    expect(service.canSeeStudent(staff(), student())).toBe(true);
    expect(service.canSeeStudent(staff(), student({ campus_id: 99 }))).toBe(true);
  });

  it('ANDs the dimensions the user is restricted on', () => {
    const user = staff({ campuses: [1], classes: [10] });
    expect(service.canSeeStudent(user, student())).toBe(true);
    expect(service.canSeeStudent(user, student({ campus_id: 2 }))).toBe(false);
    expect(service.canSeeStudent(user, student({ class_id: 11 }))).toBe(false);
  });

  it('applies segment, which rides on the student class', () => {
    const user = staff({ segments: [5] });
    expect(service.canSeeStudent(user, student())).toBe(true);
    expect(service.canSeeStudent(user, student({ segment_id: 6 }))).toBe(false);
  });

  it('excludes a null id once that dimension is restricted', () => {
    expect(service.canSeeStudent(staff({ sections: [100] }), student({ section_id: null }))).toBe(false);
    // ...but an unrestricted dimension does not care that the column is null
    expect(service.canSeeStudent(staff({ campuses: [1] }), student({ section_id: null }))).toBe(true);
  });

  it('never scopes SUPER_ADMIN', () => {
    const god = staff({ campuses: [1] }, StaffRole.SUPER_ADMIN);
    expect(service.canSeeStudent(god, student({ campus_id: 99 }))).toBe(true);
  });

  it('throws through assertStudent where canSeeStudent returns false', () => {
    expect(() => service.assertStudent(staff({ campuses: [1] }), student({ campus_id: 2 }))).toThrow(
      /campus scope/i,
    );
  });
});
