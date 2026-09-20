import 'reflect-metadata';
import { StaffRole } from '@prisma/client';
import { BackupsController } from '../backups/backups.controller';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { TILES_MANIFEST, actionKey } from './tiles.manifest';
import { computeEffectiveAccess, type EffectiveTile } from './access.effective';
import {
  REQUIRE_ACTION_KEY,
  type RequireActionMetadata,
} from '../../decorators/require-action.decorator';

const tile = (id: string) => TILES_MANIFEST.find((t) => t.id === id)!;

const effectiveTiles: EffectiveTile[] = TILES_MANIFEST.map((t) => ({
  id: t.id,
  capabilities: t.capabilities,
  actions: t.actions?.map((a) => ({ id: a.id, default: !!a.default, implies: a.implies ?? [] })),
  legacyFullAccessCapabilities: t.legacyFullAccessCapabilities,
}));
const base = {
  allPermissionKeys: [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))],
  activeTiles: effectiveTiles,
  packTileIds: [] as string[],
  allowTileIds: [] as string[],
  denyTileIds: [] as string[],
  userPerms: [] as { key: string; granted: boolean }[],
};

function meta(target: object, handler?: string): RequireActionMetadata | undefined {
  return Reflect.getMetadata(REQUIRE_ACTION_KEY, handler ? (target as any)[handler] : (target as any));
}

function routesOf(controller: new (...args: any[]) => unknown): string[] {
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto).filter(
    (n) => n !== 'constructor' && typeof proto[n] === 'function' && Reflect.getMetadata('method', proto[n]) !== undefined,
  );
}

/** Everything a CAMPUS_ADMIN holds by default: every capability except the four seed-permissions withholds. */
const CAMPUS_ADMIN_KEYS = base.allPermissionKeys.filter(
  (k) => !['system.permissions.manage', 'system.users.edit', 'system.backups.view', 'communication.send_employee_announcements'].includes(k),
);

describe('Database Backups', () => {
  const t = tile('system.backups');

  // Regression: this controller had only JwtStaffGuard, so any logged-in staff
  // member could download or delete database backups through the API.
  it('is action-gated, not just authenticated', () => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', BackupsController) ?? [];
    expect(guards).toContain(TileActionGuard);
    expect(meta(BackupsController)?.actionKeys).toEqual([actionKey('system.backups', 'view')]);
  });

  it('puts every write and the download on its own action, and leaves no route ungated', () => {
    const p = BackupsController.prototype;
    expect(meta(p, 'triggerBackup')?.actionKeys).toEqual([actionKey('system.backups', 'trigger')]);
    expect(meta(p, 'downloadBackup')?.actionKeys).toEqual([actionKey('system.backups', 'download')]);
    expect(meta(p, 'deleteBackup')?.actionKeys).toEqual([actionKey('system.backups', 'delete')]);
    const classMeta = meta(BackupsController);
    for (const h of routesOf(BackupsController)) {
      expect({ h, gated: !!meta(p, h) || !!classMeta }).toEqual({ h, gated: true });
    }
    for (const a of ['view', 'trigger', 'download', 'delete']) {
      expect(t.actions!.some((x) => x.id === a)).toBe(true);
    }
  });

  it('has NO legacy bridge and one default action, so nobody inherits a backup power', () => {
    expect(t.legacyFullAccessCapabilities).toBeUndefined();
    expect(t.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
  });

  it('gives no default role but SUPER_ADMIN the tile at all: even a CAMPUS_ADMIN holds nothing', () => {
    const campusAdmin = computeEffectiveAccess({ ...base, role: StaffRole.CAMPUS_ADMIN, roleKeys: CAMPUS_ADMIN_KEYS });
    expect(campusAdmin.tileIds).not.toContain('system.backups');
    expect(campusAdmin.actionIds.filter((k) => k.startsWith('system.backups#'))).toEqual([]);
    const teacher = computeEffectiveAccess({ ...base, role: StaffRole.EMPLOYEE, roleKeys: ['attendance.self.view', 'hr.leave.apply'] });
    expect(teacher.tileIds).not.toContain('system.backups');
    const sa = computeEffectiveAccess({ ...base, role: StaffRole.SUPER_ADMIN });
    for (const a of t.actions!) expect(sa.actionIds).toContain(actionKey('system.backups', a.id));
  });

  it('lets a SUPER_ADMIN delegate each power separately: a granted tile is view-only until an action is added', () => {
    const viewOnly = computeEffectiveAccess({ ...base, role: StaffRole.EMPLOYEE, allowTileIds: ['system.backups'] });
    expect(viewOnly.actionIds.filter((k) => k.startsWith('system.backups#'))).toEqual([actionKey('system.backups', 'view')]);
    const downloader = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      allowTileIds: ['system.backups'],
      userActionGrants: [{ tileId: 'system.backups', actionId: 'download', allow: true }],
    });
    const held = downloader.actionIds.filter((k) => k.startsWith('system.backups#'));
    expect(held).toContain(actionKey('system.backups', 'download'));
    expect(held).not.toContain(actionKey('system.backups', 'delete'));
    expect(held).not.toContain(actionKey('system.backups', 'trigger'));
  });
});
