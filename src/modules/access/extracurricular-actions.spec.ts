import 'reflect-metadata';

import { StaffRole } from '@prisma/client';
import { EcChargesController } from '../extracurricular/charges/ec-charges.controller';
import { EcClassScheduleController } from '../extracurricular/class-schedule/ec-class-schedule.controller';
import { EcDepositsController } from '../extracurricular/deposits/ec-deposits.controller';
import { EcFeeHeadsController } from '../extracurricular/fee-heads/ec-fee-heads.controller';
import { EcReportsController } from '../extracurricular/reports/ec-reports.controller';
import { EcVouchersController } from '../extracurricular/vouchers/ec-vouchers.controller';
import { StudentsController } from '../students/students.controller';
import { EC_LIVE_TILES } from '../extracurricular/ec.constants';
import { MANIFEST_EFFECTIVE_TILES, TILES_MANIFEST, actionKey } from './tiles.manifest';
import { computeEffectiveAccess } from './access.effective';
import { REQUIRE_ACTION_KEY, type RequireActionMetadata } from '../../decorators/require-action.decorator';

/**
 * TAFSD-605: the Extracurricular Fees module. Every route is gated by a real
 * tile action, the module reaches nobody by default, and the shared-feeder
 * allowlist (EC_LIVE_TILES) matches the manifest.
 */

const EC_CONTROLLERS = [EcFeeHeadsController, EcClassScheduleController, EcChargesController, EcVouchersController, EcDepositsController, EcReportsController];

/** EC tiles whose pages pick a student, and so must be on the student search allowlist. */
const EC_TILES_WITH_STUDENT_SEARCH = [
    'extracurricular.student_charges',
    'extracurricular.single_voucher',
    'extracurricular.receive_deposit',
    'extracurricular.payment_history',
    'extracurricular.bulk_voucher',
];

const ecTiles = TILES_MANIFEST.filter((t) => t.module === 'extracurricular');
const tile = (id: string) => TILES_MANIFEST.find((t) => t.id === id);

function routeHandlers(controller: new (...args: any[]) => unknown): string[] {
    const proto = controller.prototype as Record<string, unknown>;
    return Object.getOwnPropertyNames(proto).filter(
        (name) => name !== 'constructor' && typeof proto[name] === 'function' && Reflect.getMetadata('path', proto[name] as object) !== undefined,
    );
}

function meta(controller: new (...args: any[]) => unknown, handler: string): RequireActionMetadata | undefined {
    return Reflect.getMetadata(REQUIRE_ACTION_KEY, (controller.prototype as Record<string, unknown>)[handler] as object);
}

const base = {
    allPermissionKeys: [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))],
    activeTiles: MANIFEST_EFFECTIVE_TILES,
    packTileIds: [] as string[],
    allowTileIds: [] as string[],
    denyTileIds: [] as string[],
    userPerms: [] as { key: string; granted: boolean }[],
};

describe('Extracurricular Fees tiles', () => {
    it('is a module of its own with the expected tiles', () => {
        expect(ecTiles.map((t) => t.id).sort()).toEqual([
            'extracurricular.bulk_voucher',
            'extracurricular.class_schedule',
            'extracurricular.fee_heads',
            'extracurricular.payment_history',
            'extracurricular.receive_deposit',
            'extracurricular.reports',
            'extracurricular.single_voucher',
            'extracurricular.student_charges',
            'extracurricular.vouchers',
        ]);
        for (const t of ecTiles) {
            expect(t.href.startsWith('/extracurricular/')).toBe(true);
            expect(t.capabilities).toEqual([`${t.id}.view`]);
            expect(t.actions?.some((a) => a.id === 'view' && a.default)).toBe(true);
        }
    });

    it('keeps EC_LIVE_TILES in step with the manifest', () => {
        expect([...EC_LIVE_TILES].sort()).toEqual(ecTiles.map((t) => t.id).sort());
    });

    it('bridges no legacy capability into any EC tile', () => {
        for (const t of ecTiles) expect(t.legacyFullAccessCapabilities ?? []).toEqual([]);
    });

    it('gates every EC route with a real tile action or an EC tile allowlist', () => {
        for (const controller of EC_CONTROLLERS) {
            const handlers = routeHandlers(controller);
            expect(handlers.length).toBeGreaterThan(0);
            for (const handler of handlers) {
                const m = meta(controller, handler);
                expect({ route: `${controller.name}.${handler}`, gated: !!m }).toEqual({ route: `${controller.name}.${handler}`, gated: true });
                if (m!.mode === 'tile') {
                    expect(m!.tileIds?.length).toBeGreaterThan(0);
                    for (const id of m!.tileIds!) expect({ id, ec: id.startsWith('extracurricular.') && !!tile(id) }).toEqual({ id, ec: true });
                } else {
                    expect(m!.actionKeys.length).toBeGreaterThan(0);
                    for (const key of m!.actionKeys) {
                        const [tileId, actionId] = key.split('#');
                        expect({ key, ok: tileId.startsWith('extracurricular.') && !!tile(tileId)?.actions?.some((a) => a.id === actionId) }).toEqual({ key, ok: true });
                    }
                }
            }
        }
    });

    it('lets the EC pages that pick a student use the shared student search', () => {
        const m = meta(StudentsController, 'searchSimple');
        expect(m?.mode).toBe('tile');
        for (const id of EC_TILES_WITH_STUDENT_SEARCH) expect(m?.tileIds).toContain(id);
    });

    it('gives no role an EC tile by default, even one holding every capability', () => {
        for (const role of Object.values(StaffRole).filter((r) => r !== StaffRole.SUPER_ADMIN)) {
            const access = computeEffectiveAccess({ ...base, role, roleKeys: base.allPermissionKeys });
            expect({ role, tiles: access.tileIds.filter((id) => id.startsWith('extracurricular.')) }).toEqual({ role, tiles: [] });
            expect({ role, actions: access.actionIds.filter((k) => k.startsWith('extracurricular.')) }).toEqual({ role, actions: [] });
        }
    });

    it('confers only view when a tile is granted to a person, and more only when ticked', () => {
        const granted = computeEffectiveAccess({
            ...base,
            role: StaffRole.FINANCE_CLERK,
            roleKeys: [],
            allowTileIds: ['extracurricular.fee_heads'],
        });
        expect(granted.tileIds).toContain('extracurricular.fee_heads');
        expect(granted.actionIds.filter((k) => k.startsWith('extracurricular.'))).toEqual([actionKey('extracurricular.fee_heads', 'view')]);

        const withEdit = computeEffectiveAccess({
            ...base,
            role: StaffRole.FINANCE_CLERK,
            roleKeys: [],
            allowTileIds: ['extracurricular.fee_heads'],
            userActionGrants: [{ tileId: 'extracurricular.fee_heads', actionId: 'edit', allow: true }],
        });
        expect(withEdit.actionIds).toEqual(
            expect.arrayContaining([actionKey('extracurricular.fee_heads', 'view'), actionKey('extracurricular.fee_heads', 'edit')]),
        );
        expect(withEdit.actionIds).not.toContain(actionKey('extracurricular.fee_heads', 'delete'));
    });

    it('gives SUPER_ADMIN every EC action', () => {
        const sa = computeEffectiveAccess({ ...base, role: StaffRole.SUPER_ADMIN, roleKeys: [] });
        for (const t of ecTiles) {
            for (const a of t.actions ?? []) expect(sa.actionIds).toContain(actionKey(t.id, a.id));
        }
    });
});
