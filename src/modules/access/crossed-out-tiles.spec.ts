import 'reflect-metadata';

// uuid ships ESM that jest here does not transform; nothing below generates an id.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('@react-pdf/renderer', () => ({ renderToBuffer: jest.fn() }));

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { StaffRole } from '@prisma/client';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { REQUIRE_ACTION_KEY, type RequireActionMetadata } from '../../decorators/require-action.decorator';
import { computeEffectiveAccess } from './access.effective';
import { MANIFEST_EFFECTIVE_TILES, TILES_MANIFEST } from './tiles.manifest';
import { AccessController } from './access.controller';
import { AnalyticsController } from '../analytics/analytics.controller';
import { ClassSessionReschedulesController } from '../attendance/class-session-reschedules.controller';
import { StaffLessonReschedulesController } from '../attendance/staff-lesson-reschedules.controller';
import { ZkAttendanceMappingController } from '../attendance/zk-attendance-mapping.controller';
import { ClassesController } from '../classes/classes.controller';
import { SectionsController } from '../sections/sections.controller';
import { DiscountPresetsController } from '../discount-presets/discount-presets.controller';
import { BundleNamesController } from '../fee-types/bundle-names.controller';
import { FeeTypesController } from '../fee-types/fee-types.controller';
import { FeesController } from '../fees/fees.controller';
import { HouseBalancerController } from '../house-balancer/house-balancer.controller';
import { DepartmentsController } from '../hr/departments/departments.controller';
import { SegmentsController } from '../hr/segments/segments.controller';
import { ScholarshipPresetsController } from '../scholarship-presets/scholarship-presets.controller';
import { SubjectsController } from '../timetables/subjects.controller';
import { TeachingGroupsController } from '../timetables/teaching-groups.controller';
import { TimetablesController } from '../timetables/timetables.controller';
import { UsersController } from '../users/users.controller';
import { DepositsController } from '../vouchers/deposits.controller';
import { VouchersController } from '../vouchers/vouchers.controller';

/**
 * TAFSD-287: a crossed-out web tile must close the API behind it, not just the
 * menu. These routes were guarded only by CASL, which a role baseline still
 * satisfies after the tile is crossed out. Each now also names the tiles whose
 * pages call it.
 */

const allKeys = [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))];

/** A staff token built the way login builds it, with web tiles default-deny. */
function tokenFor(opts: { role?: StaffRole; roleKeys?: string[]; allowTileIds?: string[] }) {
  const r = computeEffectiveAccess({
    role: opts.role ?? StaffRole.PRINCIPAL,
    allPermissionKeys: allKeys,
    activeTiles: MANIFEST_EFFECTIVE_TILES,
    roleKeys: opts.roleKeys ?? [],
    packTileIds: [],
    allowTileIds: opts.allowTileIds ?? [],
    denyTileIds: [],
    userPerms: [],
  });
  return {
    sub: 'u',
    username: 'u',
    role: opts.role ?? StaffRole.PRINCIPAL,
    campusId: null,
    allowedClassIds: [],
    userType: 'STAFF' as const,
    permissions: r.capabilityKeys,
    actions: r.actionIds,
  };
}

function allows(meta: RequireActionMetadata, user: unknown): boolean {
  const reflector = { getAllAndOverride: () => meta } as unknown as Reflector;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  try {
    return new TileActionGuard(reflector).canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

/** [controller, handlers that must carry a tile allowlist] */
const GATED: [string, any, number][] = [
  ['access', AccessController, 1],
  ['analytics', AnalyticsController, 1],
  ['class-reschedules', ClassSessionReschedulesController, 8],
  ['staff-lesson-reschedules', StaffLessonReschedulesController, 10],
  ['zk-device-mappings', ZkAttendanceMappingController, 3],
  ['classes', ClassesController, 1],
  ['sections', SectionsController, 1],
  ['discount-presets', DiscountPresetsController, 2],
  ['bundle-names', BundleNamesController, 4],
  ['fee-types', FeeTypesController, 2],
  ['fees', FeesController, 1],
  ['house-balancer', HouseBalancerController, 2],
  ['departments', DepartmentsController, 1],
  ['segments', SegmentsController, 2],
  ['scholarship-presets', ScholarshipPresetsController, 5],
  ['subjects', SubjectsController, 1],
  ['teaching-groups', TeachingGroupsController, 3],
  ['timetables', TimetablesController, 5],
  // updateRolePermission now needs access_packs#manage, not just the tile (TAFSD-365).
  ['users', UsersController, 3],
  ['deposits', DepositsController, 1],
  ['vouchers', VouchersController, 4],
];

function tileGatedHandlers(controller: any): [string, RequireActionMetadata][] {
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => [name, Reflect.getMetadata(REQUIRE_ACTION_KEY, controller.prototype[name])] as const)
    .filter(([, meta]) => meta?.mode === 'tile')
    .map(([name, meta]) => [name, meta as RequireActionMetadata]);
}

function hasTileActionGuard(controller: any, handler: string): boolean {
  const guards = [
    ...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []),
    ...(Reflect.getMetadata(GUARDS_METADATA, controller.prototype[handler]) ?? []),
  ];
  return guards.includes(TileActionGuard);
}

describe.each(GATED)('%s: crossed-out tiles close the API', (_label, controller, expected) => {
  const handlers = tileGatedHandlers(controller);

  it('gates every route that used to rely on the role baseline alone', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(expected);
  });

  it.each(handlers)('%s actually runs TileActionGuard', (handler) => {
    expect(hasTileActionGuard(controller, handler)).toBe(true);
  });

  it.each(handlers)('%s names only real web tiles', (_handler, meta) => {
    for (const id of meta.tileIds ?? []) {
      const tile = TILES_MANIFEST.find((t) => t.id === id);
      expect({ id, web: (tile?.surface ?? (tile ? 'web' : 'missing')) === 'web' }).toEqual({ id, web: true });
    }
  });

  it.each(handlers)('%s refuses a role that holds every capability but no ticked tile', (_handler, meta) => {
    expect(allows(meta, tokenFor({ roleKeys: allKeys }))).toBe(false);
  });

  it.each(handlers)('%s opens for each of its tiles once that tile alone is ticked', (_handler, meta) => {
    for (const id of meta.tileIds ?? []) {
      expect({ id, ok: allows(meta, tokenFor({ roleKeys: allKeys, allowTileIds: [id] })) }).toEqual({ id, ok: true });
    }
  });

  it.each(handlers)('%s stays open to SUPER_ADMIN', (_handler, meta) => {
    expect(allows(meta, tokenFor({ role: StaffRole.SUPER_ADMIN }))).toBe(true);
  });
});
