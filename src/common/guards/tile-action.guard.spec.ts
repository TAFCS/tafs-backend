import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffRole } from '@prisma/client';
import { TileActionGuard } from './tile-action.guard';
import type { RequireActionMetadata } from '../../decorators/require-action.decorator';

function contextFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function guardWith(meta: RequireActionMetadata | undefined) {
  const reflector = { getAllAndOverride: () => meta } as unknown as Reflector;
  return new TileActionGuard(reflector);
}

const staff = (actions: string[], role: StaffRole = StaffRole.EMPLOYEE) => ({
  sub: 'u1',
  username: 'alice',
  role,
  campusId: null,
  allowedClassIds: [],
  userType: 'STAFF' as const,
  permissions: [],
  actions,
});

describe('TileActionGuard', () => {
  it('lets an undecorated route through untouched', () => {
    expect(guardWith(undefined).canActivate(contextFor(staff([])))).toBe(true);
  });

  it('lets a decorated route with no ids through', () => {
    const guard = guardWith({ mode: 'all', actionKeys: [] });
    expect(guard.canActivate(contextFor(staff([])))).toBe(true);
  });

  it('allows when every required action is held', () => {
    const guard = guardWith({ mode: 'all', actionKeys: ['t#a', 't#b'] });
    expect(guard.canActivate(contextFor(staff(['t#a', 't#b'])))).toBe(true);
  });

  it('denies when one required action is missing', () => {
    const guard = guardWith({ mode: 'all', actionKeys: ['t#a', 't#b'] });
    expect(() => guard.canActivate(contextFor(staff(['t#a'])))).toThrow(ForbiddenException);
  });

  it('any-mode allows on a single match', () => {
    const guard = guardWith({ mode: 'any', actionKeys: ['t#a', 't#b'] });
    expect(guard.canActivate(contextFor(staff(['t#b'])))).toBe(true);
  });

  it('any-mode denies when none match', () => {
    const guard = guardWith({ mode: 'any', actionKeys: ['t#a', 't#b'] });
    expect(() => guard.canActivate(contextFor(staff(['t#c'])))).toThrow(ForbiddenException);
  });

  it('SUPER_ADMIN bypasses regardless of held actions', () => {
    const guard = guardWith({ mode: 'all', actionKeys: ['t#a'] });
    expect(guard.canActivate(contextFor(staff([], StaffRole.SUPER_ADMIN)))).toBe(true);
  });

  it('denies a parent session', () => {
    const guard = guardWith({ mode: 'all', actionKeys: ['t#a'] });
    const parent = { sub: 1, familyId: 1, userType: 'PARENT' as const };
    expect(() => guard.canActivate(contextFor(parent))).toThrow(ForbiddenException);
  });

  it('denies a session whose token predates actions', () => {
    const guard = guardWith({ mode: 'all', actionKeys: ['t#a'] });
    const legacy = { ...staff([]), actions: undefined };
    expect(() => guard.canActivate(contextFor(legacy))).toThrow(ForbiddenException);
  });
});
