import { PrismaClient, StaffRole } from '@prisma/client';
import { CAMPUS_A, CAMPUS_B, CLASS_APR, CLASS_AUG, SECTION, STUDENT, USERS, bumpSequence, seedSchool, type SeededUser } from '../helpers/fixtures';

/**
 * The Student Directory's world, on top of seedSchool():
 *
 * - every student's campus/class/section is an active placement
 *   (campus_classes + campus_sections), because any edit that touches a
 *   placed student runs the section-allocation check;
 * - Class VII (12) as a promotion target at campus A;
 * - two houses, and student A1 in RED;
 * - campus-A GR numbers are digits only (that campus's series), campus B's
 *   start KF-A (id 2 is wired to Kaneez Fatima's prefix);
 * - one family: A1 and A2 are siblings, with a father and a mother;
 * - the five special categories the migrations seed in production.
 *
 * Users, all resolved from the database like a real login:
 * - dirClerk: Student Directory in full (legacy students.directory.edit),
 *   scoped to campus A;
 * - dirViewer: the tile alone, so only its default `view` action;
 * - dirNoStatus: everything except `status.change`;
 * - payHistoryOnly: only the Payment History tile.
 * USERS.admin (SUPER_ADMIN) from seedSchool is unrestricted.
 */
export const CLASS_VII = 12;
export const HOUSE = { RED: 1, BLUE: 2 } as const;
export const FAMILY = 1;
export const FATHER_CNIC = '42101-1111111-1';
export const MOTHER_CNIC = '42101-2222222-2';
export const GR = { A1: '101', A2: '102', A_APR: '103', B1: 'KF-A-1' } as const;

export const DIR_USERS = {
    dirClerk: { id: 'db-suite-dir-clerk', username: 'dbsuite.dirclerk', role: StaffRole.RECEPTIONIST },
    dirViewer: { id: 'db-suite-dir-viewer', username: 'dbsuite.dirviewer', role: StaffRole.RECEPTIONIST },
    dirNoStatus: { id: 'db-suite-dir-nostatus', username: 'dbsuite.dirnostatus', role: StaffRole.RECEPTIONIST },
    payHistoryOnly: { id: 'db-suite-payhist', username: 'dbsuite.payhist', role: StaffRole.FINANCE_CLERK },
} satisfies Record<string, SeededUser>;

const DIRECTORY = 'student.directory';

export async function seedDirectory(prisma: PrismaClient) {
    await seedSchool(prisma);

    await prisma.classes.create({
        data: { id: CLASS_VII, description: 'Class VII', class_code: 'VII', academic_system: 'MATRIC', term_start_month: 8 },
    });
    await bumpSequence(prisma, 'classes');

    const placements: [number, number][] = [
        [CAMPUS_A, CLASS_AUG],
        [CAMPUS_A, CLASS_APR],
        [CAMPUS_A, CLASS_VII],
        [CAMPUS_B, CLASS_AUG],
    ];
    await prisma.campus_classes.createMany({
        data: placements.map(([campus_id, class_id]) => ({ campus_id, class_id, is_active: true })),
    });
    await prisma.campus_sections.createMany({
        data: placements.map(([campus_id, class_id]) => ({ campus_id, class_id, section_id: SECTION, is_active: true })),
    });

    await prisma.houses.createMany({
        data: [
            { id: HOUSE.RED, house_name: 'RED', house_color: '#ff0000' },
            { id: HOUSE.BLUE, house_name: 'BLUE', house_color: '#0000ff' },
        ],
    });
    await bumpSequence(prisma, 'houses');

    await prisma.families.create({ data: { id: FAMILY, household_name: 'TEST HOUSEHOLD', home_phone: '021-1111111' } });
    await bumpSequence(prisma, 'families');

    const grs: [number, string][] = [
        [STUDENT.A1, GR.A1],
        [STUDENT.A2, GR.A2],
        [STUDENT.A_APR, GR.A_APR],
        [STUDENT.B1, GR.B1],
    ];
    for (const [cc, gr_number] of grs) {
        await prisma.students.update({ where: { cc }, data: { gr_number } });
    }
    await prisma.students.update({ where: { cc: STUDENT.A1 }, data: { house_id: HOUSE.RED, family_id: FAMILY, gender: 'MALE', doa: new Date('2026-08-01') } });
    await prisma.students.update({ where: { cc: STUDENT.A2 }, data: { family_id: FAMILY, gender: 'FEMALE' } });

    const father = await prisma.guardians.create({ data: { full_name: 'TEST FATHER', cnic: FATHER_CNIC, primary_phone: '03001111111' } });
    const mother = await prisma.guardians.create({ data: { full_name: 'TEST MOTHER', cnic: MOTHER_CNIC } });
    for (const cc of [STUDENT.A1, STUDENT.A2]) {
        await prisma.student_guardians.createMany({
            data: [
                { student_id: cc, guardian_id: father.id, relationship: 'FATHER', is_primary_contact: true },
                { student_id: cc, guardian_id: mother.id, relationship: 'MOTHER' },
            ],
        });
    }

    await prisma.student_categories.createMany({
        data: [
            { code: 'FEE_ENDOWMENT', label: 'Fee Endowment', display_order: 1, updated_at: new Date() },
            { code: 'FEE_ENDOWMENT_MTF', label: 'Fee Endowment (MTF)', display_order: 2, updated_at: new Date() },
            { code: 'COMPLEMENTARY', label: 'Complementary', display_order: 3, updated_at: new Date() },
            { code: 'SEHM_E_SADAAT', label: 'Sehm-e-Sadaat', display_order: 4, updated_at: new Date() },
            { code: 'SEHM_E_IMAM', label: 'Sehm-e-Imam', display_order: 5, updated_at: new Date() },
        ],
    });

    await seedDirectoryUsers(prisma);
    return { fatherId: father.id, motherId: mother.id };
}

async function seedDirectoryUsers(prisma: PrismaClient) {
    for (const u of Object.values(DIR_USERS)) {
        await prisma.users.create({
            data: { id: u.id, username: u.username, full_name: u.username, role: u.role, password_hash: 'x', is_active: true },
        });
    }
    const perm = (key: string, module: string) =>
        prisma.permissions.upsert({ where: { key }, update: {}, create: { key, module, description: key } });
    await perm('students.directory.view', 'students');
    const edit = await perm('students.directory.edit', 'students');

    const grantTile = (user: SeededUser, tile_id: string) =>
        prisma.user_tile_grants.create({ data: { user_id: user.id, tile_id, allow: true, granted_by: USERS.admin.id } });
    const grantFullDirectory = (user: SeededUser) =>
        prisma.user_permissions.create({ data: { user_id: user.id, permission_id: edit.id, granted: true, granted_by: USERS.admin.id } });

    await grantTile(DIR_USERS.dirClerk, DIRECTORY);
    await grantFullDirectory(DIR_USERS.dirClerk);
    await prisma.user_scope_entries.create({ data: { user_id: DIR_USERS.dirClerk.id, dimension: 'CAMPUS', ref_id: CAMPUS_A } });

    await grantTile(DIR_USERS.dirViewer, DIRECTORY);

    await grantTile(DIR_USERS.dirNoStatus, DIRECTORY);
    await grantFullDirectory(DIR_USERS.dirNoStatus);
    await prisma.user_tile_action_grants.create({
        data: { user_id: DIR_USERS.dirNoStatus.id, tile_id: DIRECTORY, action_id: 'status.change', allow: false, granted_by: USERS.admin.id },
    });

    await grantTile(DIR_USERS.payHistoryOnly, 'finance.payment_history');
}

/** Audit rows written with `void auditLogs.log(...)` land after the response. */
export async function waitForAudit<T>(read: () => Promise<T[]>, atLeast = 1, timeoutMs = 3000): Promise<T[]> {
    const started = Date.now();
    for (;;) {
        const rows = await read();
        if (rows.length >= atLeast || Date.now() - started > timeoutMs) return rows;
        await new Promise((r) => setTimeout(r, 50));
    }
}
