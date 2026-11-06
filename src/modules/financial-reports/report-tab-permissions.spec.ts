import 'reflect-metadata';
import { StaffRole } from '@prisma/client';
import { FinancialReportsController } from './financial-reports.controller';
import { FinancialReportsService } from './financial-reports.service';
import { ScopeService } from '../../common/scope/scope.service';
import { TILES_MANIFEST, actionKey } from '../access/tiles.manifest';
import { computeEffectiveAccess, type EffectiveTile } from '../access/access.effective';
import { REQUIRE_ACTION_KEY, type RequireActionMetadata } from '../../decorators/require-action.decorator';

// TAFSD-482: each Financial Reports tab is its own sub-permission, and
// fee-heads snapshots follow the caller's scope.

const TILE = 'finance.financial_reports';
const k = (id: string) => actionKey(TILE, id);

const effectiveTiles: EffectiveTile[] = TILES_MANIFEST.map((t) => ({
  id: t.id,
  capabilities: t.capabilities,
  actions: t.actions?.map((a) => ({ id: a.id, default: !!a.default, implies: a.implies ?? [] })),
  legacyFullAccessCapabilities: t.legacyFullAccessCapabilities,
}));
const base = {
  allPermissionKeys: [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))],
  activeTiles: effectiveTiles,
  roleKeys: [] as string[],
  packTileIds: [] as string[],
  allowTileIds: [TILE],
  denyTileIds: [] as string[],
  userPerms: [] as { key: string; granted: boolean }[],
};
const held = (r: { actionIds: string[] }) => r.actionIds.filter((a) => a.startsWith(`${TILE}#`));

function routeKeys(handler: string): string[] {
  const m: RequireActionMetadata | undefined = Reflect.getMetadata(
    REQUIRE_ACTION_KEY,
    (FinancialReportsController.prototype as any)[handler],
  );
  return m?.actionKeys ?? [];
}

describe('Financial Reports tab permissions', () => {
  it('gives every tab to anyone granted the tile, so the split took nothing away', () => {
    const r = computeEffectiveAccess({ ...base, role: StaffRole.EMPLOYEE });
    for (const tab of ['fee_heads.view', 'deposits.view', 'fee_matrix.view', 'defaulters.view']) {
      expect(held(r)).toContain(k(tab));
    }
  });

  it('unticking a tab removes it and the actions that live on it, and leaves the others', () => {
    const r = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      userActionGrants: [
        { tileId: TILE, actionId: 'defaulters.view', allow: false },
        { tileId: TILE, actionId: 'defaulters.notify', allow: true },
      ],
    });
    expect(held(r)).not.toContain(k('defaulters.view'));
    expect(held(r)).not.toContain(k('defaulters.notify'));
    expect(held(r)).toContain(k('fee_heads.view'));
    expect(held(r)).toContain(k('view'));
  });

  it("guards each tab's routes with that tab's view, and exports with the tab view AND export", () => {
    // GETs only: POST fee-heads/snapshots shares a path with the list and is
    // guarded by snapshot.manage.
    const routes = Object.getOwnPropertyNames(FinancialReportsController.prototype).filter((n) => {
      const fn = (FinancialReportsController.prototype as any)[n];
      return n !== 'constructor' && Reflect.getMetadata('path', fn) !== undefined && Reflect.getMetadata('method', fn) === 0;
    });
    const byPath = new Map(
      routes.map((n) => [Reflect.getMetadata('path', (FinancialReportsController.prototype as any)[n]) as string, n]),
    );
    const expectRoute = (path: string, keys: string[]) => expect(routeKeys(byPath.get(path)!)).toEqual(keys.map(k));

    expectRoute('fee-heads', ['fee_heads.view']);
    expectRoute('fee-heads/export', ['fee_heads.view', 'export']);
    expectRoute('fee-heads/snapshots', ['fee_heads.view']);
    expectRoute('deposits', ['deposits.view']);
    expectRoute('deposits/export', ['deposits.view', 'export']);
    expectRoute('fee-matrix', ['fee_matrix.view']);
    expectRoute('fee-matrix/export', ['fee_matrix.view', 'export']);
    expectRoute('defaulters', ['defaulters.view']);
    expectRoute('defaulters/export', ['defaulters.view', 'export']);
    expectRoute('filter-options', ['view']);
  });
});

describe('Fee heads snapshots follow scope', () => {
  const scopeService = new ScopeService({} as any);
  const service = new FinancialReportsService({} as any, {} as any, scopeService);
  const inScope = (filters: unknown, user: unknown) => (service as any).snapshotInScope(filters, user) as boolean;

  const scope = (campuses: number[]) => ({
    campuses,
    segments: [],
    classes: [],
    sections: [],
    departments: [],
    staffCategories: [],
  });
  const johar = { role: StaffRole.EMPLOYEE, scope: scope([1]) };
  const unrestricted = { role: StaffRole.EMPLOYEE, scope: scope([]) };
  const superAdmin = { role: StaffRole.SUPER_ADMIN };

  it('hides a whole-school or other-campus snapshot from a campus-scoped user', () => {
    expect(inScope({ campus_id: undefined }, johar)).toBe(false);
    expect(inScope({ campus_id: [2] }, johar)).toBe(false);
    expect(inScope({ campus_id: [1, 2] }, johar)).toBe(false);
    expect(inScope({ campus_id: [1] }, johar)).toBe(true);
  });

  it('shows every snapshot to unrestricted users and super admins', () => {
    expect(inScope({}, unrestricted)).toBe(true);
    expect(inScope({ campus_id: [2] }, superAdmin)).toBe(true);
  });

  it("records a scoped creator's campuses in the snapshot so they can still see it", () => {
    const floored = (service as any).floorSnapshotFiltersToScope({ from_date: '2026-01-01', to_date: '2026-01-31' }, johar);
    expect(floored.campus_id).toEqual([1]);
    expect(inScope({ campus_id: floored.campus_id }, johar)).toBe(true);
  });
});
