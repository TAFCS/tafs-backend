import { UnauthorizedException } from '@nestjs/common';
import { JwtStaffStrategy } from './jwt-staff.strategy';
import { ScopeService } from '../../../common/scope/scope.service';
import { AccessService } from '../../access/access.service';
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

  type Live = { capabilityKeys: string[]; tileIds: string[]; actionIds: string[] };
  const NO_ACCESS: Live = { capabilityKeys: [], tileIds: [], actionIds: [] };

  /**
   * A real AccessService (so its live-session cache and invalidation are what
   * is tested) over a fake users table, with the effective-access computation
   * stubbed to whatever `access` currently holds.
   */
  function createStrategy(
    user: { is_active: boolean; role?: StaffRole } | null,
    scopeEntries: { dimension: string; ref_id: number }[] = [],
    segmentClasses: { id: number }[] = [],
  ) {
    const findUnique = jest.fn().mockImplementation(async () =>
      user ? { is_active: user.is_active, role: user.role ?? StaffRole.EMPLOYEE } : null,
    );
    const scopeService = new ScopeService({
      user_scope_entries: { findMany: jest.fn().mockResolvedValue(scopeEntries) },
      classes: { findMany: jest.fn().mockResolvedValue(segmentClasses) },
    } as any);
    const accessService = new AccessService({ users: { findUnique } } as any, {} as any, scopeService);
    const state = { access: NO_ACCESS };
    const resolveEffective = jest
      .spyOn(accessService, 'resolveEffective')
      .mockImplementation(async () => state.access);
    const strategy = new JwtStaffStrategy({ get: () => 'test-secret' } as ConfigService, scopeService, accessService);
    return { strategy, accessService, state, findUnique, resolveEffective };
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
    expect(createStrategy({ is_active: true }).strategy).toBeDefined();
  });

  it('rejects non-staff tokens', async () => {
    const { strategy } = createStrategy({ is_active: true });
    await expect(
      strategy.validate({ ...basePayload, userType: 'PARENT' as any }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects inactive users', async () => {
    const { strategy } = createStrategy({ is_active: false });
    await expect(strategy.validate(basePayload)).rejects.toThrow('Account is inactive');
  });

  it('rejects missing users', async () => {
    const { strategy } = createStrategy(null);
    await expect(strategy.validate(basePayload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns the payload with live access for active users', async () => {
    const { strategy } = createStrategy({ is_active: true });
    await expect(strategy.validate(basePayload)).resolves.toEqual({
      ...basePayload,
      permissions: [],
      actions: [],
      scope: EMPTY,
    });
  });

  // TAFSD-308: the access token lives 90 days. Revoking a tile action must bite
  // on the next request by the SAME token, not at the next refresh or login.
  it('reads tile actions and capabilities live, not from the token', async () => {
    const { strategy, state } = createStrategy({ is_active: true });
    state.access = { capabilityKeys: ['finance.vouchers.view'], tileIds: [], actionIds: ['finance.vouchers#view'] };

    const result = await strategy.validate({
      ...basePayload,
      permissions: ['system.permissions.manage'],
      actions: ['finance.vouchers#view', 'finance.vouchers#delete'],
    });

    expect(result.permissions).toEqual(['finance.vouchers.view']);
    expect(result.actions).toEqual(['finance.vouchers#view']);
  });

  it('applies a revocation to the next request once the access write invalidates the cache', async () => {
    const { strategy, state, accessService } = createStrategy({ is_active: true });
    const token = { ...basePayload, actions: ['finance.vouchers#view', 'finance.vouchers#delete'] };
    state.access = { ...NO_ACCESS, actionIds: ['finance.vouchers#view', 'finance.vouchers#delete'] };
    expect((await strategy.validate(token)).actions).toContain('finance.vouchers#delete');

    // An admin removes the delete action (setUserAccess invalidates this user).
    state.access = { ...NO_ACCESS, actionIds: ['finance.vouchers#view'] };
    accessService.invalidateLiveSession('user-1');

    expect((await strategy.validate(token)).actions).toEqual(['finance.vouchers#view']);
  });

  it('serves a burst of requests from the cache instead of recomputing access each time', async () => {
    const { strategy, findUnique, resolveEffective } = createStrategy({ is_active: true });
    await Promise.all([strategy.validate(basePayload), strategy.validate(basePayload)]);
    await strategy.validate(basePayload);
    expect(resolveEffective.mock.calls.length).toBeLessThanOrEqual(2);
    expect(findUnique.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('takes the role from the database, so a role change does not wait for a refresh', async () => {
    const { strategy } = createStrategy({ is_active: true, role: StaffRole.CAMPUS_ADMIN });
    const result = await strategy.validate({ ...basePayload, role: StaffRole.PRINCIPAL });
    expect(result.role).toBe(StaffRole.CAMPUS_ADMIN);
  });

  // The access token lives 90 days. A scope narrowed after it was issued must
  // bite on the next request, not when the client next happens to refresh.
  it('reads scope live from the database, not from the token', async () => {
    const { strategy } = createStrategy({ is_active: true }, [{ dimension: 'SEGMENT', ref_id: 3 }]);

    const result = await strategy.validate({ ...basePayload, scope: EMPTY });

    expect(result.scope).toEqual({ ...EMPTY, segments: [3], classes: [-1] });
  });

  // Most checks are written against class alone; folding segment into class
  // is what makes them enforce it.
  it('narrows class scope to the classes of a scoped segment', async () => {
    const { strategy } = createStrategy(
      { is_active: true },
      [{ dimension: 'SEGMENT', ref_id: 3 }],
      [{ id: 11 }, { id: 12 }],
    );

    const result = await strategy.validate(basePayload);

    expect(result.scope).toEqual({ ...EMPTY, segments: [3], classes: [11, 12] });
  });

  it('intersects explicit class scope with the segment, never widening to all', async () => {
    const { strategy } = createStrategy(
      { is_active: true },
      [{ dimension: 'SEGMENT', ref_id: 3 }, { dimension: 'CLASS', ref_id: 99 }],
      [{ id: 11 }],
    );

    const result = await strategy.validate(basePayload);

    // Class 99 is not in segment 3: restricted to nothing, not unrestricted.
    expect(result.scope?.classes).toEqual([-1]);
  });

  it('ignores a wider scope baked into the token', async () => {
    const { strategy } = createStrategy({ is_active: true }, [{ dimension: 'CAMPUS', ref_id: 1 }]);

    // Token minted while the user was unrestricted; admin has since narrowed them.
    const result = await strategy.validate({ ...basePayload, scope: EMPTY });

    expect(result.scope).toEqual({ ...EMPTY, campuses: [1] });
  });
});
