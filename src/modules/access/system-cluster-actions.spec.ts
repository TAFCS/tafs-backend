import 'reflect-metadata';
import { StaffRole } from '@prisma/client';
import { BackupsController } from '../backups/backups.controller';
import { AccessController } from './access.controller';
import { AuditLogsGuard } from '../audit-logs/guards/audit-logs.guard';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ScopeService } from '../../common/scope/scope.service';
import type { ExecutionContext } from '@nestjs/common';
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

describe('Access Packs', () => {
  const t = tile('system.access_packs');

  it('bridges from system.permissions.manage, which no default role but SUPER_ADMIN holds', () => {
    expect(t.legacyFullAccessCapabilities).toEqual(['system.permissions.manage']);
    expect(t.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
    const campusAdmin = computeEffectiveAccess({ ...base, role: StaffRole.CAMPUS_ADMIN, roleKeys: CAMPUS_ADMIN_KEYS });
    expect(campusAdmin.tileIds).not.toContain('system.access_packs');
    const holder = computeEffectiveAccess({ ...base, role: StaffRole.EMPLOYEE, roleKeys: ['system.permissions.manage'] });
    for (const a of t.actions!) expect(holder.actionIds).toContain(actionKey('system.access_packs', a.id));
  });

  it('puts pack create / update / delete on `manage` and leaves the list open (People & Access shares it)', () => {
    const p = AccessController.prototype;
    for (const h of ['createPack', 'updatePack', 'deletePack']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('system.access_packs', 'manage')]);
    }
    expect(meta(p, 'listPacks')).toBeUndefined();
  });
});

describe('Activity Logs: delegation and scope', () => {
  const guard = new AuditLogsGuard();
  const ctx = (user: unknown, query: Record<string, unknown> = {}) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user, query }) }) }) as unknown as ExecutionContext;
  const staff = (role: string, opts: { permissions?: string[]; actions?: string[] } = {}) => ({
    userType: 'STAFF', role, permissions: opts.permissions ?? [], actions: opts.actions ?? [],
  });

  it('keeps the role allowlist exactly as it was', () => {
    for (const role of ['SUPER_ADMIN', 'CAMPUS_ADMIN', 'PRINCIPAL']) expect(guard.canActivate(ctx(staff(role)))).toBe(true);
    for (const role of ['FINANCE_CLERK', 'TEACHER', 'RECEPTIONIST', 'EMPLOYEE']) expect(guard.canActivate(ctx(staff(role)))).toBe(false);
  });

  it('keeps the directory-staff path: one student\'s timeline only', () => {
    const dir = staff('TEACHER', { permissions: ['students.directory.view'] });
    expect(guard.canActivate(ctx(dir, { student_id: '5' }))).toBe(true);
    expect(guard.canActivate(ctx(dir, {}))).toBe(false);
  });

  it('lets a user a SUPER_ADMIN delegated the Activity Logs tile to see the feed, and nobody else', () => {
    const viaGrant = computeEffectiveAccess({ ...base, role: StaffRole.FINANCE_CLERK, allowTileIds: ['system.activity_logs'] });
    const delegated = staff('FINANCE_CLERK', { permissions: viaGrant.capabilityKeys, actions: viaGrant.actionIds });
    expect(guard.canActivate(ctx(delegated))).toBe(true);
    // a finance clerk with the finance capabilities alone is still refused
    const clerk = computeEffectiveAccess({ ...base, role: StaffRole.FINANCE_CLERK, roleKeys: ['finance.vouchers.view', 'finance.deposits.record'] });
    expect(guard.canActivate(ctx(staff('FINANCE_CLERK', { permissions: clerk.capabilityKeys, actions: clerk.actionIds })))).toBe(false);
    expect(guard.canActivate(ctx({ userType: 'PARENT' }))).toBe(false);
  });

  describe('the feed a scope-restricted caller sees', () => {
    const realScope = new ScopeService({} as any);
    const mk = () => {
      const audit_logs = { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
      // Any other table the service reads (users, employees, ...) answers "nothing".
      const other = () => ({ findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) });
      const prisma: any = new Proxy({ audit_logs }, { get: (t: any, k: string) => t[k] ?? (t[k] = other()) });
      return { svc: new AuditLogsService(prisma as any, realScope), prisma };
    };
    const user = (role: string, extra: Record<string, unknown> = {}) =>
      ({ sub: 'u', role, campusId: null, allowedClassIds: [], userType: 'STAFF', permissions: [], actions: [], scope: { campuses: [], segments: [], classes: [], sections: [], departments: [], staffCategories: [] }, ...extra }) as any;
    const whereOf = (prisma: any) => JSON.stringify(prisma.audit_logs.findMany.mock.calls[0]?.[0]?.where ?? {});

    it('adds a student-scope clause for a campus-scoped caller, and for a legacy campus-bound one', async () => {
      for (const u of [
        user('CAMPUS_ADMIN', { scope: { campuses: [3], segments: [], classes: [], sections: [], departments: [], staffCategories: [] } }),
        // pre-scope session: no scope claim, only campusId
        user('CAMPUS_ADMIN', { scope: undefined, campusId: 3 }),
      ]) {
        const { svc, prisma } = mk();
        await svc.findAll({} as any, u);
        expect(whereOf(prisma)).toContain('"students"');
      }
    });
    it('leaves SUPER_ADMIN and an unrestricted caller with the full feed', async () => {
      for (const u of [user('SUPER_ADMIN'), user('CAMPUS_ADMIN'), user('PRINCIPAL')]) {
        const { svc, prisma } = mk();
        await svc.findAll({} as any, u);
        expect(whereOf(prisma)).not.toContain('"students"');
      }
    });
    it('applies the scope to one student\'s timeline too', async () => {
      const { svc, prisma } = mk();
      await svc.findAll({ student_id: '5' } as any, user('CAMPUS_ADMIN', { scope: undefined, campusId: 3 }));
      expect(whereOf(prisma)).toContain('"students"');
    });
  });
});
