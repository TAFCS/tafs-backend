import { PrismaClient, StaffRole } from '@prisma/client';

const prisma = new PrismaClient();

const permissionsList = [
    // Academic Administration
    { key: 'academic.campuses.view', module: 'Academic Administration', description: 'View campuses' },
    { key: 'academic.campuses.edit', module: 'Academic Administration', description: 'Create/Edit campuses' },
    { key: 'academic.classes.view', module: 'Academic Administration', description: 'View classes' },
    { key: 'academic.classes.edit', module: 'Academic Administration', description: 'Create/Edit classes' },
    { key: 'academic.sections.view', module: 'Academic Administration', description: 'View sections' },
    { key: 'academic.sections.edit', module: 'Academic Administration', description: 'Create/Edit sections' },
    { key: 'academic.transfers.view', module: 'Academic Administration', description: 'View student transfers' },
    { key: 'academic.transfers.execute', module: 'Academic Administration', description: 'Execute student transfers' },
    { key: 'academic.bulk_promote.execute', module: 'Academic Administration', description: 'Perform bulk promotion' },

    // Student Management
    { key: 'students.registration.view', module: 'Student Management', description: 'View registration list' },
    { key: 'students.registration.create', module: 'Student Management', description: 'Register new students' },
    { key: 'students.enrollment.view', module: 'Student Management', description: 'View enrollment list' },
    { key: 'students.enrollment.complete', module: 'Student Management', description: 'Complete admission (SOFT -> ENROLLED)' },
    { key: 'students.directory.view', module: 'Student Management', description: 'View student directory' },
    { key: 'students.directory.edit', module: 'Student Management', description: 'Edit student details' },
    { key: 'students.families.view', module: 'Student Management', description: 'View families directory' },
    { key: 'students.families.edit', module: 'Student Management', description: 'Edit family/guardian details' },

    // Fee Administration
    { key: 'fee_admin.fee_types.view', module: 'Fee Administration', description: 'View fee types' },
    { key: 'fee_admin.fee_types.edit', module: 'Fee Administration', description: 'Manage fee types' },
    { key: 'fee_admin.classwise_schedule.view', module: 'Fee Administration', description: 'View class fee schedules' },
    { key: 'fee_admin.classwise_schedule.edit', module: 'Fee Administration', description: 'Manage class fee schedules' },
    { key: 'fee_admin.studentwise_schedule.view', module: 'Fee Administration', description: 'View student overrides' },
    { key: 'fee_admin.studentwise_schedule.edit', module: 'Fee Administration', description: 'Manage student overrides' },
    { key: 'fee_admin.bundles.view', module: 'Fee Administration', description: 'View fee bundles' },
    { key: 'fee_admin.bundles.edit', module: 'Fee Administration', description: 'Manage fee bundles' },

    // Finance Operations
    { key: 'finance.vouchers.generate_single', module: 'Finance Operations', description: 'Generate single voucher' },
    { key: 'finance.vouchers.generate_bulk', module: 'Finance Operations', description: 'Generate bulk vouchers' },
    { key: 'finance.vouchers.view', module: 'Finance Operations', description: 'View vouchers' },
    { key: 'finance.vouchers.download', module: 'Finance Operations', description: 'Download voucher PDFs' },
    { key: 'finance.vouchers.split_partial', module: 'Finance Operations', description: 'Split vouchers for partial pay' },
    { key: 'finance.deposits.record', module: 'Finance Operations', description: 'Record new deposits' },
    { key: 'finance.deposits.view', module: 'Finance Operations', description: 'View deposit history' },
    { key: 'finance.banks.view', module: 'Finance Operations', description: 'View bank accounts' },
    { key: 'finance.banks.edit', module: 'Finance Operations', description: 'Manage bank accounts' },

    // System Administration
    { key: 'system.users.view', module: 'System Administration', description: 'View staff accounts' },
    { key: 'system.users.edit', module: 'System Administration', description: 'Manage staff accounts' },
    { key: 'system.permissions.manage', module: 'System Administration', description: 'Manage user permissions' },
    { key: 'system.analytics.view', module: 'System Administration', description: 'View dashboard analytics' },
    { key: 'system.analytics.view_amounts', module: 'System Administration', description: 'View financial amounts in analytics' },
];

async function main() {
    console.log('Seeding permissions...');

    for (const p of permissionsList) {
        await prisma.permissions.upsert({
            where: { key: p.key },
            update: { module: p.module, description: p.description },
            create: p,
        });
    }

    const allPerms = await prisma.permissions.findMany();
    const permId = (key: string) => allPerms.find(p => p.key === key)!.id;

    console.log('Seeding role defaults...');

    const roleMappings: Record<StaffRole, string[]> = {
        SUPER_ADMIN: allPerms.map(p => p.key),
        CAMPUS_ADMIN: allPerms.map(p => p.key).filter(k => 
            !['system.permissions.manage', 'system.users.edit'].includes(k)
        ),
        PRINCIPAL: [
            'academic.campuses.view', 'academic.classes.view', 'academic.sections.view', 'academic.transfers.view',
            'students.registration.view', 'students.enrollment.view', 'students.directory.view', 'students.families.view',
            'students.directory.edit', 'students.families.edit', // Principal can usually edit kids
            'fee_admin.fee_types.view', 'fee_admin.classwise_schedule.view', 'fee_admin.studentwise_schedule.view', 'fee_admin.bundles.view',
            'finance.vouchers.view', 'finance.deposits.view', 'finance.banks.view',
            'system.analytics.view', 'system.analytics.view_amounts'
        ],
        FINANCE_CLERK: [
            'students.directory.view', 'students.families.view',
            'finance.vouchers.generate_single', 'finance.vouchers.generate_bulk', 
            'finance.vouchers.view', 'finance.vouchers.download', 'finance.vouchers.split_partial',
            'finance.deposits.record', 'finance.deposits.view', 'finance.banks.view'
        ],
        RECEPTIONIST: [
            'students.registration.create', 'students.directory.view', 'students.families.view',
            'finance.vouchers.view'
        ],
        TEACHER: [
            'students.directory.view', 'system.analytics.view'
        ],
        STAFF_EDITOR: [
            'students.directory.view', 'students.directory.edit', 'students.registration.view'
        ],
    };

    for (const [role, keys] of Object.entries(roleMappings)) {
        console.log(`Setting up role: ${role}`);
        for (const key of keys) {
            await prisma.role_permissions.upsert({
                where: {
                    role_permission_id: { // Assuming unique composite but we didn't name it that in schema?
                        // Wait, schema said @@unique([role, permission_id])
                        role: role as StaffRole,
                        permission_id: permId(key)
                    }
                },
                update: {},
                create: {
                    role: role as StaffRole,
                    permission_id: permId(key)
                }
            });
        }
    }

    console.log('Seeding complete.');
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
