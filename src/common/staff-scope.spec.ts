import { ForbiddenException } from '@nestjs/common';
import {
  applyStudentScope,
  assertClassInScope,
  resolveAnalyticsCampusId,
} from './staff-scope';
import type { IJwtStaffPayload } from '../modules/auth/interfaces/jwt-payload.interface';

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
  it('forces campus_id when user has campusId', () => {
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

  it('resolveAnalyticsCampusId locks to user campus', () => {
    expect(resolveAnalyticsCampusId(staff({ campusId: 2 }), undefined)).toBe(2);
    expect(() => resolveAnalyticsCampusId(staff({ campusId: 2 }), 1)).toThrow(
      ForbiddenException,
    );
  });
});
