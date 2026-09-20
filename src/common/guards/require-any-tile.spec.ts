import 'reflect-metadata';

// uuid ships ESM that jest here does not transform; nothing below generates an id.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('@react-pdf/renderer', () => ({ renderToBuffer: jest.fn() }));

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffRole } from '@prisma/client';
import { TileActionGuard } from './tile-action.guard';
import { StudentsController } from '../../modules/students/students.controller';
import { EmployeesController } from '../../modules/hr/employees/employees.controller';
import { TILES_MANIFEST, userHoldsTile } from '../../modules/access/tiles.manifest';
import { computeEffectiveAccess, type EffectiveTile } from '../../modules/access/access.effective';
import {
  REQUIRE_ACTION_KEY,
  type RequireActionMetadata,
} from '../../decorators/require-action.decorator';

const effectiveTiles: EffectiveTile[] = TILES_MANIFEST.map((t) => ({
  id: t.id,
  capabilities: t.capabilities,
  actions: t.actions?.map((a) => ({ id: a.id, default: !!a.default, implies: a.implies ?? [] })),
  legacyFullAccessCapabilities: t.legacyFullAccessCapabilities,
}));
const allKeys = [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))];

/** A realistic staff token, built the way login builds it. */
function tokenFor(opts: { role?: StaffRole; roleKeys?: string[]; allowTileIds?: string[]; denyTileIds?: string[] }) {
  const r = computeEffectiveAccess({
    role: opts.role ?? StaffRole.EMPLOYEE,
    allPermissionKeys: allKeys,
    activeTiles: effectiveTiles,
    roleKeys: opts.roleKeys ?? [],
    packTileIds: [],
    allowTileIds: opts.allowTileIds ?? [],
    denyTileIds: opts.denyTileIds ?? [],
    userPerms: [],
  });
  return {
    sub: 'u',
    username: 'u',
    role: opts.role ?? StaffRole.EMPLOYEE,
    campusId: null,
    allowedClassIds: [],
    userType: 'STAFF' as const,
    permissions: r.capabilityKeys,
    actions: r.actionIds,
  };
}

function guardFor(controller: { prototype: object }, handler: string) {
  const meta: RequireActionMetadata = Reflect.getMetadata(REQUIRE_ACTION_KEY, (controller.prototype as any)[handler]);
  const reflector = { getAllAndOverride: () => meta } as unknown as Reflector;
  const guard = new TileActionGuard(reflector);
  const ctx = (user: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    }) as unknown as ExecutionContext;
  return { meta, allows: (user: unknown) => { try { return guard.canActivate(ctx(user)); } catch (e) { if (e instanceof ForbiddenException) return false; throw e; } } };
}

describe.each([
  ['GET /students/search-simple', StudentsController],
  ['GET /hr/employees/search-simple', EmployeesController],
])('%s is open to an allowlist of tiles, not to everyone', (_label, controller) => {
  const { meta, allows } = guardFor(controller, 'searchSimple');
  const tiles = meta?.tileIds ?? [];

  it('is declared as a tile allowlist (and not the old single-tile action)', () => {
    expect(meta?.mode).toBe('tile');
    expect(tiles.length).toBeGreaterThan(1);
    expect(meta?.actionKeys).toEqual([]);
  });

  it('names only tiles that exist in the manifest', () => {
    for (const id of tiles) expect({ id, exists: TILES_MANIFEST.some((t) => t.id === id) }).toEqual({ id, exists: true });
    expect(new Set(tiles).size).toBe(tiles.length);
  });

  it('lets a holder of EACH allowlisted tile in, however they hold it (role capability or a tile grant)', () => {
    for (const id of tiles) {
      const tile = TILES_MANIFEST.find((t) => t.id === id)!;
      const byGrant = tokenFor({ allowTileIds: [id] });
      expect({ id, via: 'grant', ok: allows(byGrant) }).toEqual({ id, via: 'grant', ok: true });
      const byRole = tokenFor({ roleKeys: [...tile.capabilities] });
      expect({ id, via: 'role', ok: allows(byRole) }).toEqual({ id, via: 'role', ok: true });
    }
  });

  it('refuses a holder of a tile that is NOT on the list, and a user with no tile at all', () => {
    const outside = TILES_MANIFEST.filter((t) => !tiles.includes(t.id) && t.surface !== 'staff_app');
    expect(outside.length).toBeGreaterThan(5);
    for (const t of outside) {
      // hold the outside tile in full via its capabilities AND via a grant
      const viaCaps = tokenFor({ roleKeys: [...t.capabilities] });
      const viaGrant = tokenFor({ allowTileIds: [t.id] });
      for (const [how, token] of [['caps', viaCaps], ['grant', viaGrant]] as const) {
        // Some capabilities are shared with an allowlisted tile (e.g. two tiles list
        // finance.vouchers.view); then holding the outside tile means holding that one too.
        const holdsAllowlisted = tiles.some((id) => userHoldsTile(token, id));
        expect({ tile: t.id, how, ok: allows(token) }).toEqual({ tile: t.id, how, ok: holdsAllowlisted });
      }
    }
    expect(allows(tokenFor({}))).toBe(false);
    expect(allows(tokenFor({ roleKeys: ['hr.leave.apply', 'attendance.self.view'] }))).toBe(false);
  });

  it('honours a SUPER_ADMIN tile denial for a tile that has sub-permissions', () => {
    const withActions = tiles.find((id) => TILES_MANIFEST.find((t) => t.id === id)?.actions?.length);
    expect(withActions).toBeDefined();
    const tile = TILES_MANIFEST.find((t) => t.id === withActions)!;
    // Hold ONLY this tile in full, then deny it: no other allowlisted tile shares its capabilities
    // unless the manifest says so, so check the denied token loses this tile itself.
    const denied = tokenFor({ roleKeys: [...tile.capabilities], denyTileIds: [tile.id] });
    expect(userHoldsTile(denied, tile.id)).toBe(false);
  });

  it('always lets SUPER_ADMIN through, and never lets a parent through', () => {
    expect(allows(tokenFor({ role: StaffRole.SUPER_ADMIN }))).toBe(true);
    expect(allows({ sub: 1, familyId: 1, userType: 'PARENT' })).toBe(false);
    expect(allows(undefined)).toBe(false);
  });
});

describe('userHoldsTile', () => {
  it('uses the default action for a tile with sub-permissions, and capabilities for one without', () => {
    const withActions = tokenFor({ allowTileIds: ['finance.receive_deposit'] });
    expect(userHoldsTile(withActions, 'finance.receive_deposit')).toBe(true);
    expect(userHoldsTile(withActions, 'finance.vouchers')).toBe(false);
    // attendance.quick_check_in has no actions yet
    expect(TILES_MANIFEST.find((t) => t.id === 'attendance.quick_check_in')?.actions).toBeUndefined();
    expect(userHoldsTile(tokenFor({ allowTileIds: ['attendance.quick_check_in'] }), 'attendance.quick_check_in')).toBe(true);
    expect(userHoldsTile(tokenFor({}), 'attendance.quick_check_in')).toBe(false);
  });

  it('falls back to capabilities for a session issued before the actions claim existed', () => {
    const old = { permissions: ['finance.deposits.record'], actions: undefined };
    expect(userHoldsTile(old, 'finance.receive_deposit')).toBe(true);
    expect(userHoldsTile({ permissions: [], actions: undefined }, 'finance.receive_deposit')).toBe(false);
  });

  it('is false for an unknown tile id', () => {
    expect(userHoldsTile({ permissions: allKeys, actions: [] }, 'no.such_tile')).toBe(false);
  });
});
