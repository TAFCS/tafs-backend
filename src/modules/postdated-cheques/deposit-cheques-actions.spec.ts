import 'reflect-metadata';
import { StaffRole } from '@prisma/client';
import { PostdatedChequesController } from './postdated-cheques.controller';
import { VouchersController } from '../vouchers/vouchers.controller';
import { TILES_MANIFEST, actionKey } from '../access/tiles.manifest';
import { computeEffectiveAccess, type EffectiveTile } from '../access/access.effective';
import {
  REQUIRE_ACTION_KEY,
  type RequireActionMetadata,
} from '../../decorators/require-action.decorator';

const POSTDATED = 'finance.postdated_cheques';
const DEPOSIT = 'finance.receive_deposit';

const postdated = TILES_MANIFEST.find((t) => t.id === POSTDATED)!;
const deposit = TILES_MANIFEST.find((t) => t.id === DEPOSIT)!;

const effectiveTiles: EffectiveTile[] = TILES_MANIFEST.map((t) => ({
  id: t.id,
  capabilities: t.capabilities,
  actions: t.actions?.map((a) => ({ id: a.id, default: !!a.default, implies: a.implies ?? [] })),
  legacyFullAccessCapabilities: t.legacyFullAccessCapabilities,
}));

const allKeys = [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))];

const base = {
  allPermissionKeys: allKeys,
  activeTiles: effectiveTiles,
  roleKeys: [] as string[],
  packTileIds: [] as string[],
  allowTileIds: [] as string[],
  denyTileIds: [] as string[],
  userPerms: [] as { key: string; granted: boolean }[],
};

function required(target: object, handler: string): RequireActionMetadata | undefined {
  return Reflect.getMetadata(REQUIRE_ACTION_KEY, (target as any)[handler]);
}

function everyManifestKeyExists(keys: string[]) {
  for (const key of keys) {
    const [tileId, actionId] = key.split('#');
    const tile = TILES_MANIFEST.find((t) => t.id === tileId);
    expect({ key, tileExists: !!tile }).toEqual({ key, tileExists: true });
    expect({ key, actionExists: tile!.actions?.some((a) => a.id === actionId) }).toEqual({
      key,
      actionExists: true,
    });
  }
}

describe('Post-dated Cheques sub-permissions', () => {
  it('has one default action and NO legacy bridge', () => {
    expect(postdated.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
    // Nobody held a dedicated permission before, so nobody may inherit one.
    expect(postdated.legacyFullAccessCapabilities).toBeUndefined();
  });

  it('is not visible on the strength of a capability every voucher clerk holds', () => {
    expect(postdated.capabilities).toEqual(['finance.postdated_cheques.view']);
  });

  it('is invisible to a role that only holds ordinary finance capabilities', () => {
    const r = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: ['finance.vouchers.view', 'finance.deposits.record', 'finance.vouchers.generate_single'],
    });
    expect(r.tileIds).not.toContain(POSTDATED);
    expect(r.actionIds.filter((k) => k.startsWith(`${POSTDATED}#`))).toEqual([]);
  });

  it('grants only `view` when a SUPER_ADMIN grants the bare tile', () => {
    const r = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      allowTileIds: [POSTDATED],
    });
    expect(r.tileIds).toContain(POSTDATED);
    expect(r.actionIds.filter((k) => k.startsWith(`${POSTDATED}#`))).toEqual([actionKey(POSTDATED, 'view')]);
  });

  it('grants a write action only when it is granted explicitly', () => {
    const r = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      allowTileIds: [POSTDATED],
      userActionGrants: [{ tileId: POSTDATED, actionId: 'update_status', allow: true }],
    });
    const held = r.actionIds.filter((k) => k.startsWith(`${POSTDATED}#`));
    expect(held).toContain(actionKey(POSTDATED, 'update_status'));
    expect(held).not.toContain(actionKey(POSTDATED, 'delete'));
    expect(held).not.toContain(actionKey(POSTDATED, 'create'));
  });

  it('gives SUPER_ADMIN every action', () => {
    const r = computeEffectiveAccess({ ...base, role: StaffRole.SUPER_ADMIN });
    for (const a of postdated.actions!) expect(r.actionIds).toContain(actionKey(POSTDATED, a.id));
  });

  it('gates every route: view by default, writes on their own action', () => {
    const cls: RequireActionMetadata | undefined = Reflect.getMetadata(
      REQUIRE_ACTION_KEY,
      PostdatedChequesController,
    );
    expect(cls?.actionKeys).toEqual([actionKey(POSTDATED, 'view')]);

    const proto = PostdatedChequesController.prototype;
    expect(required(proto, 'create')?.actionKeys).toEqual([actionKey(POSTDATED, 'create')]);
    expect(required(proto, 'updateStatus')?.actionKeys).toEqual([actionKey(POSTDATED, 'update_status')]);
    expect(required(proto, 'remove')?.actionKeys).toEqual([actionKey(POSTDATED, 'delete')]);
    everyManifestKeyExists([...(cls?.actionKeys ?? [])]);
  });
});

describe('Receive Deposit sub-permissions', () => {
  it('has one default action and bridges from the capability that already opens the tile', () => {
    expect(deposit.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
    expect(deposit.capabilities).toEqual(['finance.deposits.record']);
    expect(deposit.legacyFullAccessCapabilities).toEqual(['finance.deposits.record']);
  });

  it('keeps every action for a role that already holds finance.deposits.record', () => {
    const r = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: ['finance.deposits.record'],
    });
    for (const a of deposit.actions!) expect(r.actionIds).toContain(actionKey(DEPOSIT, a.id));
  });

  // A tile grant also confers the tile's own capabilities, and here that
  // capability IS the bridge, so a bare grant means the whole tile. Same as
  // every other tile bridged from the capability that opens it. Narrowing is
  // done by denying the actions a person should not have.
  it('confers the whole tile on a bare grant, and a per-action deny narrows it', () => {
    const bare = computeEffectiveAccess({ ...base, role: StaffRole.EMPLOYEE, allowTileIds: [DEPOSIT] });
    for (const a of deposit.actions!) expect(bare.actionIds).toContain(actionKey(DEPOSIT, a.id));

    const narrowed = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      allowTileIds: [DEPOSIT],
      userActionGrants: [
        { tileId: DEPOSIT, actionId: 'record', allow: false },
        { tileId: DEPOSIT, actionId: 'waive', allow: false },
      ],
    });
    expect(narrowed.actionIds).toContain(actionKey(DEPOSIT, 'view'));
    expect(narrowed.actionIds).not.toContain(actionKey(DEPOSIT, 'record'));
    expect(narrowed.actionIds).not.toContain(actionKey(DEPOSIT, 'waive'));
  });

  it.each([
    ['recordDeposit', 'all', [actionKey(DEPOSIT, 'record')]],
    ['previewSplit', 'all', [actionKey(DEPOSIT, 'split')]],
    ['waiveVoucher', 'any', [actionKey(DEPOSIT, 'waive'), actionKey('finance.student_overrides', 'waive')]],
    ['unwaiveVoucher', 'any', [actionKey(DEPOSIT, 'waive'), actionKey('finance.student_overrides', 'waive')]],
    [
      'splitPartiallyPaid',
      'any',
      [actionKey(DEPOSIT, 'split'), actionKey('finance.vouchers', 'edit'), actionKey('finance.single_voucher', 'create')],
    ],
    [
      'generatePdf',
      'any',
      [actionKey(DEPOSIT, 'print'), actionKey('finance.vouchers', 'edit'), actionKey('finance.single_voucher', 'create')],
    ],
    ['generateMainColumnReceipt', 'any', [actionKey(DEPOSIT, 'main_receipt'), actionKey('finance.vouchers', 'edit')]],
  ])('%s is gated as expected and names only real actions', (handler, mode, keys) => {
    const meta = required(VouchersController.prototype, handler as string);
    expect(meta?.mode).toBe(mode);
    expect(meta?.actionKeys).toEqual(keys);
    everyManifestKeyExists(meta!.actionKeys);
  });

  // Routes shared with other tiles must never be pinned to Receive Deposit
  // alone, or every voucher / single-voucher / overrides user loses them.
  it.each(['waiveVoucher', 'unwaiveVoucher', 'splitPartiallyPaid', 'generatePdf', 'generateMainColumnReceipt'])(
    'shared route %s also accepts a sibling tile',
    (handler) => {
      const meta = required(VouchersController.prototype, handler)!;
      expect(meta.mode).toBe('any');
      expect(meta.actionKeys.some((k) => !k.startsWith(`${DEPOSIT}#`))).toBe(true);
    },
  );
});
