import { Prisma, PrismaClient, StaffRole } from '@prisma/client';

/**
 * Minimal school for the DB suite: two campuses, two classes (Aug-Jul and
 * Apr-Mar terms), the three fee types the code hard-codes by id, a class fee
 * template, four students and four staff users whose access is resolved from
 * the database exactly like a real login.
 */
export const YEAR = '2026-2027';

export const CAMPUS_A = 1;
export const CAMPUS_B = 2;
export const CLASS_AUG = 10; // term_start_month 8 (Aug-Jul)
export const CLASS_APR = 11; // term_start_month 4 (Apr-Mar)
export const SECTION = 20;

/** Ids the service hard-codes: scholarships are MTF-only, caution fee is 3. */
export const FEE = { MTF: 1, ANNUAL: 2, CAUTION: 3 } as const;

export const STUDENT = {
    A1: 9001, // campus A, Aug-Jul class
    A2: 9002, // campus A, Aug-Jul class
    A_APR: 9003, // campus A, Apr-Mar class
    B1: 9101, // campus B: outside the campus-scoped clerk's reach
} as const;

export type SeededUser = { id: string; username: string; role: StaffRole };

export const USERS = {
    /** SUPER_ADMIN: every capability, every action, no scope. */
    admin: { id: 'db-suite-admin', username: 'dbsuite.admin', role: StaffRole.SUPER_ADMIN },
    /** Finance clerk holding Student Overrides in full, scoped to campus A. */
    clerk: { id: 'db-suite-clerk', username: 'dbsuite.clerk', role: StaffRole.FINANCE_CLERK },
    /** Holds the tile (view) only: CASL grants Read StudentFee and nothing more. */
    viewer: { id: 'db-suite-viewer', username: 'dbsuite.viewer', role: StaffRole.FINANCE_CLERK },
    /** Full capability (CASL passes) but `schedule.edit` denied: only TileActionGuard can stop it. */
    noEdit: { id: 'db-suite-noedit', username: 'dbsuite.noedit', role: StaffRole.FINANCE_CLERK },
} satisfies Record<string, SeededUser>;

const TILE = 'finance.student_overrides';
const VIEW_CAP = 'fee_admin.studentwise_schedule.view';
const EDIT_CAP = 'fee_admin.studentwise_schedule.edit';

// Everything the fee flows read or write. TRUNCATE ... CASCADE also clears any
// table referencing these. The access tables AccessSyncService fills on boot
// (permissions, tiles) are deliberately left alone.
const TABLES = [
    'audit_logs',
    'family_credit_ledger',
    'deposit_allocations',
    'deposits',
    'voucher_arrear_surcharges',
    'voucher_heads',
    'vouchers',
    'bank_accounts',
    'student_fees',
    'student_fee_bundles',
    'student_fee_installments',
    'discount_presets',
    'scholarship_presets',
    'class_fee_schedule',
    'students',
    'families',
    'campus_sections',
    'sections',
    'classes',
    'campuses',
    'fee_types',
    // Not reached by the CASCADE from students, so cleared by name: a guardian
    // CNIC or category code left over from one spec would collide in the next.
    'guardians',
    'houses',
    'student_categories',
    'user_scope_entries',
    'user_tile_action_grants',
    'user_tile_grants',
    'user_permissions',
    'users',
];

export async function resetDatabase(prisma: PrismaClient) {
    const list = TABLES.map((t) => `"${t}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Explicit ids skip the sequence; move it past them so app inserts don't collide. */
export async function bumpSequence(prisma: PrismaClient, table: string, column = 'id') {
    await prisma.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"${table}"', '${column}'), (SELECT COALESCE(MAX("${column}"), 0) + 1 FROM "${table}"), false)`,
    );
}

export async function seedSchool(prisma: PrismaClient) {
    await resetDatabase(prisma);

    await prisma.campuses.createMany({
        data: [
            { id: CAMPUS_A, campus_code: 'TA', campus_name: 'Test Campus A' },
            { id: CAMPUS_B, campus_code: 'TB', campus_name: 'Test Campus B' },
        ],
    });
    await prisma.classes.createMany({
        data: [
            { id: CLASS_AUG, description: 'Class VI', class_code: 'VI', academic_system: 'MATRIC', term_start_month: 8 },
            { id: CLASS_APR, description: 'O-Level I', class_code: 'O1', academic_system: 'CAMBRIDGE', term_start_month: 4 },
        ],
    });
    await prisma.sections.create({ data: { id: SECTION, description: 'A' } });
    await prisma.fee_types.createMany({
        data: [
            { id: FEE.MTF, description: 'MONTHLY TUITION FEE', priority_order: 1 },
            { id: FEE.ANNUAL, description: 'ANNUAL CHARGES', priority_order: 2 },
            { id: FEE.CAUTION, description: 'REFUNDABLE CAUTION FEE', priority_order: 3 },
        ],
    });
    await prisma.class_fee_schedule.createMany({
        data: [
            { class_id: CLASS_AUG, fee_id: FEE.MTF, amount: new Prisma.Decimal(18995), academic_year: YEAR },
            { class_id: CLASS_AUG, fee_id: FEE.ANNUAL, amount: new Prisma.Decimal(5000), academic_year: YEAR },
        ],
    });
    const student = (cc: number, campus: number, cls: number, name: string) => ({
        cc,
        full_name: name,
        status: 'ENROLLED' as const,
        campus_id: campus,
        class_id: cls,
        section_id: SECTION,
        gr_number: `GR-${cc}`,
    });
    await prisma.students.createMany({
        data: [
            student(STUDENT.A1, CAMPUS_A, CLASS_AUG, 'Test Student One'),
            student(STUDENT.A2, CAMPUS_A, CLASS_AUG, 'Test Student Two'),
            student(STUDENT.A_APR, CAMPUS_A, CLASS_APR, 'Test Student April'),
            student(STUDENT.B1, CAMPUS_B, CLASS_AUG, 'Test Student Campus B'),
        ],
    });
    await prisma.bank_accounts.create({
        data: { id: 1, account_title: 'TEST SCHOOL', account_number: '0000-TEST', bank_name: 'Test Bank' },
    });
    for (const t of ['campuses', 'classes', 'sections', 'fee_types', 'students', 'bank_accounts']) {
        await bumpSequence(prisma, t, t === 'students' ? 'cc' : 'id');
    }

    await seedUsers(prisma);
}

async function seedUsers(prisma: PrismaClient) {
    for (const u of Object.values(USERS)) {
        await prisma.users.create({
            data: { id: u.id, username: u.username, full_name: u.username, role: u.role, password_hash: 'x', is_active: true },
        });
    }

    // AccessSyncService creates the tile capability rows at boot; the legacy
    // edit capability is upserted so the user_permissions FK always resolves.
    const perm = async (key: string) =>
        prisma.permissions.upsert({
            where: { key },
            update: {},
            create: { key, module: 'fee_admin', description: key },
        });
    await perm(VIEW_CAP);
    const edit = await perm(EDIT_CAP);

    const grantTile = (user: SeededUser) =>
        prisma.user_tile_grants.create({ data: { user_id: user.id, tile_id: TILE, allow: true, granted_by: USERS.admin.id } });
    // The legacy edit capability maps to CASL Manage StudentFee and, as the
    // tile's legacyFullAccessCapability, seeds every Student Overrides action.
    const grantEdit = (user: SeededUser) =>
        prisma.user_permissions.create({
            data: { user_id: user.id, permission_id: edit.id, granted: true, granted_by: USERS.admin.id },
        });

    await grantTile(USERS.clerk);
    await grantEdit(USERS.clerk);
    await prisma.user_scope_entries.create({
        data: { user_id: USERS.clerk.id, dimension: 'CAMPUS', ref_id: CAMPUS_A },
    });

    await grantTile(USERS.viewer);

    await grantTile(USERS.noEdit);
    await grantEdit(USERS.noEdit);
    await prisma.user_tile_action_grants.create({
        data: { user_id: USERS.noEdit.id, tile_id: TILE, action_id: 'schedule.edit', allow: false, granted_by: USERS.admin.id },
    });
}

/**
 * Put existing heads on an UNPAID voucher, the way issuance leaves them:
 * a voucher_heads row per head (discounts at a negative net_amount) and the
 * head's status ISSUED. Returns the voucher id.
 */
export async function issueVoucher(prisma: PrismaClient, studentId: number, studentFeeIds: number[]) {
    const student = await prisma.students.findUniqueOrThrow({ where: { cc: studentId } });
    const fees = await prisma.student_fees.findMany({ where: { id: { in: studentFeeIds } } });
    const voucher = await prisma.vouchers.create({
        data: {
            student_id: studentId,
            campus_id: student.campus_id!,
            class_id: student.class_id!,
            bank_account_id: 1,
            issue_date: new Date('2026-08-01'),
            due_date: new Date('2026-08-10'),
            late_fee_charge: false,
            status: 'UNPAID',
        },
    });
    for (const f of fees) {
        const amount = new Prisma.Decimal(f.amount ?? 0);
        await prisma.voucher_heads.create({
            data: {
                voucher_id: voucher.id,
                student_fee_id: f.id,
                net_amount: f.is_discount ? amount.negated() : amount,
            },
        });
        if (!f.is_discount) {
            await prisma.student_fees.update({ where: { id: f.id }, data: { status: 'ISSUED' } });
        }
    }
    return voucher.id;
}
