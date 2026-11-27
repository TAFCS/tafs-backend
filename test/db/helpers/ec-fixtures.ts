import { PrismaClient, StaffRole } from '@prisma/client';
import { TILES_MANIFEST } from '../../../src/modules/access/tiles.manifest';
import { CAMPUS_A, USERS, type SeededUser } from './fixtures';

/**
 * TAFSD-605: users for the Extracurricular Fees DB specs. Seeded on top of
 * seedSchool(); access is granted per person, tile by tile, exactly as People &
 * Access does (no role gets an EC tile by default).
 */
export const EC_USERS = {
    /** Every EC tile and every action, unscoped. */
    ecManager: { id: 'db-suite-ec-manager', username: 'dbsuite.ec.manager', role: StaffRole.FINANCE_CLERK },
    /** Every EC tile and every action, scoped to campus A. */
    ecClerk: { id: 'db-suite-ec-clerk', username: 'dbsuite.ec.clerk', role: StaffRole.FINANCE_CLERK },
    /** Every EC tile, default (view) actions only. */
    ecViewer: { id: 'db-suite-ec-viewer', username: 'dbsuite.ec.viewer', role: StaffRole.FINANCE_CLERK },
} satisfies Record<string, SeededUser>;

export const EC_TILE_IDS = TILES_MANIFEST.filter((t) => t.module === 'extracurricular').map((t) => t.id);

export async function seedEcUsers(prisma: PrismaClient) {
    const ecTiles = TILES_MANIFEST.filter((t) => t.module === 'extracurricular');
    for (const u of Object.values(EC_USERS)) {
        await prisma.users.create({
            data: { id: u.id, username: u.username, full_name: u.username, role: u.role, password_hash: 'x', is_active: true },
        });
    }

    const grant = async (user: SeededUser, everyAction: boolean) => {
        for (const t of ecTiles) {
            await prisma.user_tile_grants.create({ data: { user_id: user.id, tile_id: t.id, allow: true, granted_by: USERS.admin.id } });
            if (!everyAction) continue;
            for (const a of t.actions ?? []) {
                if (a.default) continue;
                await prisma.user_tile_action_grants.create({
                    data: { user_id: user.id, tile_id: t.id, action_id: a.id, allow: true, granted_by: USERS.admin.id },
                });
            }
        }
    };

    await grant(EC_USERS.ecManager, true);
    await grant(EC_USERS.ecClerk, true);
    await prisma.user_scope_entries.create({ data: { user_id: EC_USERS.ecClerk.id, dimension: 'CAMPUS', ref_id: CAMPUS_A } });
    await grant(EC_USERS.ecViewer, false);
}

/**
 * Row counts and money sums of the academic tables, so an EC spec can prove
 * extracurricular work never touched them.
 */
export async function academicSnapshot(prisma: PrismaClient) {
    const [vouchers, heads, deposits, allocations, studentFees, ledger, schedule, feeTypes, sums] = await Promise.all([
        prisma.vouchers.count(),
        prisma.voucher_heads.count(),
        prisma.deposits.count(),
        prisma.deposit_allocations.count(),
        prisma.student_fees.count(),
        prisma.family_credit_ledger.count(),
        prisma.class_fee_schedule.count(),
        prisma.fee_types.count(),
        prisma.$queryRaw<{ fees: string | null; paid: string | null; dep: string | null }[]>`
            SELECT (SELECT SUM(amount)::text FROM student_fees) AS fees,
                   (SELECT SUM(amount_paid)::text FROM student_fees) AS paid,
                   (SELECT SUM(total_amount)::text FROM deposits) AS dep`,
    ]);
    return { vouchers, heads, deposits, allocations, studentFees, ledger, schedule, feeTypes, sums: sums[0] };
}
