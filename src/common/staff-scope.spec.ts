import { ForbiddenException } from '@nestjs/common';
import {
  applyStudentScope,
  assertClassInScope,
  resolveAnalyticsCampusIds,
} from './staff-scope';
import type { IJwtStaffPayload } from '../modules/auth/interfaces/jwt-payload.interface';

// No `scope` claim: a session minted before scope shipped, whose legacy
// campusId / allowedClassIds are read as its scope.
function staff(partial: Partial<IJwtStaffPayload>): IJwtStaffPayload {
  return {
    sub: 'u1',
    username: 'test',
    role: 'PRINCIPAL',
    campusId: 1,
    allowedClassIds: [1, 2, 3],
    userType: 'STAFF',
    permissions: [],
    ...partial,
  };
}

describe('staff-scope', () => {
  it('pins a pre-scope session to its legacy campus', () => {
    const where = applyStudentScope(staff({ campusId: 1 }), {}, { campus_id: 1 });
    expect(where.campus_id).toBe(1);
  });

  it('rejects campus outside scope', () => {
    expect(() =>
      applyStudentScope(staff({ campusId: 1 }), {}, { campus_id: 2 }),
    ).toThrow(ForbiddenException);
  });

  it('restricts to allowed class ids', () => {
    const where = applyStudentScope(
      staff({ allowedClassIds: [15, 16, 17, 18, 19] }),
      {},
      {},
    );
    expect(where.class_id).toEqual({ in: [15, 16, 17, 18, 19] });
  });

  it('assertClassInScope rejects out-of-band class', () => {
    expect(() => assertClassInScope(staff({ allowedClassIds: [4, 5] }), 9)).toThrow(
      ForbiddenException,
    );
  });

  it('resolveAnalyticsCampusIds locks a pre-scope session to its campus', () => {
    expect(resolveAnalyticsCampusIds(staff({ campusId: 2 }), undefined)).toEqual([2]);
    expect(() => resolveAnalyticsCampusIds(staff({ campusId: 2 }), [1])).toThrow(
      ForbiddenException,
    );
  });

  describe('a session carrying a scope claim', () => {
    const scope = { campuses: [1, 2, 3], segments: [], classes: [], sections: [], departments: [], staffCategories: [] };

    it('ignores the home campus: campus scope alone decides', () => {
      const user = staff({ campusId: 1, allowedClassIds: [], scope });
      expect(applyStudentScope(user, {}, {}).campus_id).toEqual({ in: [1, 2, 3] });
      expect(applyStudentScope(user, {}, { campus_id: 3 }).campus_id).toBe(3);
      expect(resolveAnalyticsCampusIds(user, undefined)).toEqual([1, 2, 3]);
    });

    it('a home campus with an unrestricted scope restricts nothing', () => {
      const user = staff({ campusId: 1, allowedClassIds: [9], scope: { ...scope, campuses: [] } });
      expect(applyStudentScope(user, {}, {})).toEqual({});
      expect(resolveAnalyticsCampusIds(user, undefined)).toBeUndefined();
      expect(() => assertClassInScope(user, 4)).not.toThrow();
    });

    it('still refuses a requested campus outside scope', () => {
      expect(() => applyStudentScope(staff({ scope }), {}, { campus_id: 7 })).toThrow(ForbiddenException);
    });
  });

  it('rejects campus outside scope when request is an array', () => {
    expect(() =>
      applyStudentScope(staff({ campusId: 1 }), {}, { campus_id: [1, 2] }),
    ).toThrow(ForbiddenException);
  });

  it('accepts campus array wholly within scope', () => {
    const where = applyStudentScope(staff({ campusId: 1 }), {}, { campus_id: [1] });
    expect(where.campus_id).toBe(1);
  });

  it('rejects class outside scope when request is an array', () => {
    expect(() =>
      applyStudentScope(
        staff({ allowedClassIds: [1, 2, 3] }),
        { class_id: { in: [1, 2, 9] } },
        { class_id: [1, 2, 9] },
      ),
    ).toThrow(ForbiddenException);
  });
});
