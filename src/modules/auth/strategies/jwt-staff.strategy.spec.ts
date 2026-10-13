import { UnauthorizedException } from '@nestjs/common';
import { JwtStaffStrategy } from './jwt-staff.strategy';
import { ScopeService } from '../../../common/scope/scope.service';
import { ConfigService } from '@nestjs/config';
import { StaffRole } from '@prisma/client';

describe('JwtStaffStrategy', () => {
  const basePayload = {
    sub: 'user-1',
    username: 'alice',
    role: StaffRole.EMPLOYEE,
    campusId: null,
    allowedClassIds: [] as number[],
    userType: 'STAFF' as const,
    permissions: [] as string[],
  };

  function createStrategy(
    prisma: { users: { findUnique: jest.Mock } },
    scopeEntries: { dimension: string; ref_id: number }[] = [],
    segmentClasses: { id: number }[] = [],
  ) {
    return new JwtStaffStrategy(
      { get: () => 'test-secret' } as ConfigService,
      prisma as any,
      new ScopeService({
        user_scope_entries: { findMany: jest.fn().mockResolvedValue(scopeEntries) },
        classes: { findMany: jest.fn().mockResolvedValue(segmentClasses) },
      } as any),
    );
  }

  const EMPTY = {
    campuses: [],
    segments: [],
    classes: [],
    sections: [],
    departments: [],
    staffCategories: [],
  };

  it('is configured with Bearer and cookie extractors', () => {
    const strategy = createStrategy({
      users: { findUnique: jest.fn() },
    });
    expect(strategy).toBeDefined();
  });

  it('rejects non-staff tokens', async () => {
    const strategy = createStrategy({
      users: { findUnique: jest.fn() },
    });
    await expect(
      strategy.validate({ ...basePayload, userType: 'PARENT' as any }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects inactive users', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', is_active: false });
    const strategy = createStrategy({ users: { findUnique } });
    await expect(strategy.validate(basePayload)).rejects.toThrow('Account is inactive');
  });

  it('rejects missing users', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const strategy = createStrategy({ users: { findUnique } });
    await expect(strategy.validate(basePayload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns payload for active users', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', is_active: true });
    const strategy = createStrategy({ users: { findUnique } });
    await expect(strategy.validate(basePayload)).resolves.toEqual({
      ...basePayload,
      actions: [],
      scope: EMPTY,
    });
  });

  it('defaults actions on tokens issued before they existed', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', is_active: true });
    const strategy = createStrategy({ users: { findUnique } });

    const result = await strategy.validate(basePayload);

    expect(result.actions).toEqual([]);
  });

  // The access token lives 90 days. A scope narrowed after it was issued must
  // bite on the next request, not when the client next happens to refresh.
  it('reads scope live from the database, not from the token', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', is_active: true });
    const strategy = createStrategy({ users: { findUnique } }, [{ dimension: 'SEGMENT', ref_id: 3 }]);

    const result = await strategy.validate({ ...basePayload, scope: EMPTY });

    expect(result.scope).toEqual({ ...EMPTY, segments: [3], classes: [-1] });
  });

  // Most checks are written against class alone; folding segment into class
  // is what makes them enforce it.
  it('narrows class scope to the classes of a scoped segment', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', is_active: true });
    const strategy = createStrategy(
      { users: { findUnique } },
      [{ dimension: 'SEGMENT', ref_id: 3 }],
      [{ id: 11 }, { id: 12 }],
    );

    const result = await strategy.validate(basePayload);

    expect(result.scope).toEqual({ ...EMPTY, segments: [3], classes: [11, 12] });
  });

  it('intersects explicit class scope with the segment, never widening to all', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', is_active: true });
    const strategy = createStrategy(
      { users: { findUnique } },
      [{ dimension: 'SEGMENT', ref_id: 3 }, { dimension: 'CLASS', ref_id: 99 }],
      [{ id: 11 }],
    );

    const result = await strategy.validate(basePayload);

    // Class 99 is not in segment 3: restricted to nothing, not unrestricted.
    expect(result.scope?.classes).toEqual([-1]);
  });

  it('preserves actions from the token', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', is_active: true });
    const strategy = createStrategy({ users: { findUnique } });

    const result = await strategy.validate({
      ...basePayload,
      actions: ['hr.employee_directory#view'],
    });

    expect(result.actions).toEqual(['hr.employee_directory#view']);
  });

  it('ignores a wider scope baked into the token', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', is_active: true });
    const strategy = createStrategy({ users: { findUnique } }, [{ dimension: 'CAMPUS', ref_id: 1 }]);

    // Token minted while the user was unrestricted; admin has since narrowed them.
    const result = await strategy.validate({ ...basePayload, scope: EMPTY });

    expect(result.scope).toEqual({ ...EMPTY, campuses: [1] });
  });
});
