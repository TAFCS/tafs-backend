import 'reflect-metadata';

// @react-pdf/renderer ships ESM that jest does not transform; nothing here
// renders a PDF, so stub it (and the component that imports it).
jest.mock('@react-pdf/renderer', () => ({ renderToBuffer: jest.fn() }));
// virtual: jest here has no tsx in moduleFileExtensions, so it cannot resolve the file.
jest.mock('../transfers/TransferOrderPDF', () => ({ TransferOrderPDF: () => null }), { virtual: true });
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { TransferController } from '../transfers/transfer.controller';
import { TransferService } from '../transfers/transfer.service';
import { HouseBalancerController } from '../house-balancer/house-balancer.controller';
import { HouseBalancerService } from '../house-balancer/house-balancer.service';
import { StudentsController } from '../students/students.controller';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
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

function keysExist(keys: string[]) {
  for (const key of keys) {
    const [tileId, actionId] = key.split('#');
    expect({ key, ok: !!tile(tileId)?.actions?.some((a) => a.id === actionId) }).toEqual({ key, ok: true });
  }
}

const scopedUser = { sub: 'u', role: 'EMPLOYEE', campusId: null, allowedClassIds: [] } as any;

describe('Transfers', () => {
  const t = tile('student.transfers');

  it('is bridged from academic.transfers.execute, so a view-only role loses only the transfer', () => {
    expect(t.legacyFullAccessCapabilities).toEqual(['academic.transfers.execute']);
    const viewOnly = computeEffectiveAccess({
      ...base,
      role: StaffRole.PRINCIPAL,
      roleKeys: ['academic.transfers.view'],
    });
    const held = viewOnly.actionIds.filter((k) => k.startsWith('student.transfers#'));
    expect(held).toEqual([actionKey('student.transfers', 'view')]);

    const executor = computeEffectiveAccess({
      ...base,
      role: StaffRole.CAMPUS_ADMIN,
      roleKeys: ['academic.transfers.view', 'academic.transfers.execute'],
    });
    for (const a of t.actions!) expect(executor.actionIds).toContain(actionKey('student.transfers', a.id));
  });

  // Regression: this controller once had no @UseGuards at all, which left
  // POST /transfers/:cc/execute open to anyone without a login.
  it('is authenticated and action-gated at the class level', () => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', TransferController) ?? [];
    expect(guards).toContain(JwtStaffGuard);
    expect(guards).toContain(TileActionGuard);
    expect(meta(TransferController)?.actionKeys).toEqual([actionKey('student.transfers', 'view')]);
  });

  it('puts the transfer and the PDF/order routes on their own actions', () => {
    const proto = TransferController.prototype;
    expect(meta(proto, 'executeTransfer')?.actionKeys).toEqual([actionKey('student.transfers', 'execute')]);
    expect(meta(proto, 'generatePdf')?.actionKeys).toEqual([actionKey('student.transfers', 'print')]);
    // Shared with the Student Directory's Transfer Order tab.
    expect(meta(proto, 'getTransferOrder')?.mode).toBe('any');
    expect(meta(proto, 'getTransferOrder')?.actionKeys).toEqual([
      actionKey('student.transfers', 'print'),
      actionKey('student.directory', 'view'),
    ]);
    keysExist(['student.transfers#view', 'student.transfers#execute', 'student.transfers#print', 'student.directory#view']);
  });

  function service(opts: { student?: unknown; canSee?: boolean; scopeThrows?: boolean }) {
    const prisma = {
      students: {
        findUnique: jest.fn().mockResolvedValue(opts.student ?? null),
        findFirst: jest.fn().mockResolvedValue(opts.student ? { cc: 1 } : null),
      },
      classes: { findUnique: jest.fn().mockResolvedValue({ description: 'X', academic_system: 'S', segment_id: 1 }) },
      campuses: { findUnique: jest.fn().mockResolvedValue({ id: 2 }) },
    };
    const scope = {
      canSeeStudent: jest.fn().mockReturnValue(opts.canSee ?? true),
      whereForStudents: jest.fn().mockReturnValue({}),
      assertCampus: jest.fn(() => {
        if (opts.scopeThrows) throw new ForbiddenException('nope');
      }),
      assertClass: jest.fn(),
      assertSegment: jest.fn(),
      assertSection: jest.fn(),
    };
    const svc = new TransferService(prisma as any, {} as any, { log: jest.fn() } as any, {} as any, {} as any, scope as any);
    return { svc, prisma, scope };
  }

  const student = { campus_id: 1, class_id: 3, section_id: 4, classes: { segment_id: 1 }, deleted_at: null };

  it('404s a student outside the caller scope on every read and on execute', async () => {
    const { svc } = service({ student, canSee: false });
    await expect(svc.getAvailableClasses(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.previewTransferGr(1, 2, undefined, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getTransferOrderData(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.executeTransfer(1, { to_class_id: 9 }, 'x', scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a transfer INTO a campus the caller cannot act on, before any write', async () => {
    const { svc, prisma } = service({ student, canSee: true, scopeThrows: true });
    await expect(
      svc.executeTransfer(1, { to_class_id: 9, to_campus_id: 2 }, 'x', scopedUser),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((prisma as any).$transaction).toBeUndefined(); // never reached
  });
});

describe('House Balancer (two tiles, one page)', () => {
  const a = tile('student.house_balancer');
  const b = tile('school-setup.house_balancer');

  it('gives both tile ids the same actions and the same bridge', () => {
    expect(a.actions).toBe(b.actions);
    expect(a.legacyFullAccessCapabilities).toEqual(['academic.campuses.edit']);
    expect(b.legacyFullAccessCapabilities).toEqual(['academic.campuses.edit']);
  });

  it('accepts either tile on every route, with preview/apply on their own actions', () => {
    const cls = meta(HouseBalancerController);
    expect(cls?.mode).toBe('any');
    expect(cls?.actionKeys).toEqual(['student.house_balancer#view', 'school-setup.house_balancer#view']);
    const p = HouseBalancerController.prototype;
    for (const h of ['preview', 'previewCampus']) {
      expect(meta(p, h)?.actionKeys).toEqual(['student.house_balancer#preview', 'school-setup.house_balancer#preview']);
    }
    for (const h of ['apply', 'applyCampus']) {
      expect(meta(p, h)?.actionKeys).toEqual(['student.house_balancer#apply', 'school-setup.house_balancer#apply']);
    }
    keysExist(cls!.actionKeys);
  });

  function svc(opts: { campusThrows?: boolean }) {
    const scope = {
      assertCampus: jest.fn(() => {
        if (opts.campusThrows) throw new ForbiddenException('nope');
      }),
      assertClass: jest.fn(),
      assertSection: jest.fn(),
      scopeOf: jest.fn().mockReturnValue({ campuses: [7] }),
    };
    const prisma = { campuses: { findUnique: jest.fn() }, audit_logs: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() } };
    const s = new HouseBalancerService(prisma as any, {} as any, {} as any, scope as any);
    return { s, scope, prisma };
  }

  it('refuses every operation on a campus outside scope before touching data', async () => {
    const { s, prisma } = svc({ campusThrows: true });
    const dto = { campus_id: 5, class_id: 1, section_id: 1 } as any;
    await expect(s.preview(dto, scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.apply({ ...dto, assignments: [], roster_fingerprint: 'x' } as any, 'x', scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.previewCampus({ campus_id: 5 } as any, scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.applyCampus({ campus_id: 5, groups: [] } as any, 'x', scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.listHistory(5, 20, 0, scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.campuses.findUnique).not.toHaveBeenCalled();
  });

  it('404s a history row from an out-of-scope campus, and one it cannot tie to a campus', async () => {
    const row = (entity_id: string) => ({ id: 1, action: 'HOUSE_REBALANCE', entity_type: 'HOUSE', entity_id, new_value: null });
    const { s, prisma } = svc({ campusThrows: true });
    prisma.audit_logs.findUnique.mockResolvedValue(row('5:1:1'));
    await expect(s.getHistory(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    prisma.audit_logs.findUnique.mockResolvedValue(row('weird'));
    await expect(s.getHistory(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Academic Actions', () => {
  it('lets a holder of only this tile reach the bulk-promote and GR-suggestion routes', () => {
    const p = StudentsController.prototype;
    for (const h of ['promoteBulk']) {
      expect(meta(p, h)?.actionKeys).toContain('student.academic_actions#promote');
      expect(meta(p, h)?.actionKeys).toContain('student.directory#promote');
    }
    // single-student promotion stays with the Student Directory
    expect(meta(p, 'promoteSingle')?.actionKeys).toEqual(['student.directory#promote']);
    keysExist(['student.academic_actions#promote']);
  });

  it('is bridged from its own opening capability', () => {
    expect(tile('student.academic_actions').legacyFullAccessCapabilities).toEqual(['academic.bulk_promote.execute']);
  });
});
