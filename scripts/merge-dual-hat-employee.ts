/**
 * Links an employee profile to an operational login, grants self-service
 * permissions, and deactivates the duplicate EMPLOYEE login.
 *
 * Usage:
 *   npx ts-node scripts/merge-dual-hat-employee.ts
 *   npx ts-node scripts/merge-dual-hat-employee.ts sara.naqvi
 */
import { PrismaClient, StaffRole } from '@prisma/client';

const prisma = new PrismaClient();

const SELF_PERMS = ['attendance.self.view', 'payroll.self.view'] as const;
const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

type MergeEntry = {
  employeeCode: string;
  operationalUsername: string;
  /** Separate EMPLOYEE-only login to deactivate after merge (omit when same account). */
  employeesUsername?: string;
  /** Promote operational account from EMPLOYEE to this role (same-login dual-hat). */
  operationalRole?: StaffRole;
  label: string;
};

const MERGES: MergeEntry[] = [
  {
    label: 'Sara Naqvi',
    employeeCode: '03-00557',
    operationalUsername: 'sara.naqvi',
    employeesUsername: 'syeda.naqvi.0557',
  },
  {
    label: 'Syeda Anita Haider',
    employeeCode: '02-001214',
    operationalUsername: 'anita.principal',
    employeesUsername: 'syeda.haider',
  },
  {
    label: 'Syed Komail Hassan',
    employeeCode: '03-00486',
    operationalUsername: 'syed.komail.hassan',
    employeesUsername: 'syed.zaidi',
  },
  {
    label: 'Sajida Rubab Adil (Mrs. Adil)',
    employeeCode: '03-00125',
    operationalUsername: 'mrs.adil',
    employeesUsername: 's.adil',
  },
  {
    label: 'Muhammad Hassan Mirza',
    employeeCode: 'EMP-MHM-001',
    operationalUsername: 'muhammad.hassan.mirza',
    operationalRole: 'SUPER_ADMIN',
  },
];

async function ensureSeedActor(): Promise<void> {
  const existing = await prisma.users.findUnique({ where: { id: SEED_ACTOR_ID } });
  if (existing) return;
  await prisma.users.create({
    data: {
      id: SEED_ACTOR_ID,
      username: '_seed_actor',
      full_name: 'Seed Actor',
      password_hash: 'unused',
      role: 'SUPER_ADMIN',
      is_active: false,
      created_at: new Date(),
      updated_at: new Date(),
    },
  });
}

async function grantPermission(userId: string, permissionKey: string): Promise<void> {
  const permission = await prisma.permissions.findUnique({ where: { key: permissionKey } });
  if (!permission) throw new Error(`Permission not found: ${permissionKey}`);

  await prisma.user_permissions.upsert({
    where: {
      user_id_permission_id: { user_id: userId, permission_id: permission.id },
    },
    update: {
      granted: true,
      granted_by: SEED_ACTOR_ID,
      granted_at: new Date(),
      note: 'merge-dual-hat-employee',
    },
    create: {
      user_id: userId,
      permission_id: permission.id,
      granted: true,
      granted_by: SEED_ACTOR_ID,
      granted_at: new Date(),
      note: 'merge-dual-hat-employee',
    },
  });
}

async function mergeOne(entry: MergeEntry): Promise<void> {
  console.log(`\n=== ${entry.label} ===`);

  let operational = await prisma.users.findUnique({
    where: { username: entry.operationalUsername },
  });
  if (!operational) {
    throw new Error(`Operational user not found: ${entry.operationalUsername}`);
  }

  if (entry.operationalRole && operational.role !== entry.operationalRole) {
    await prisma.users.update({
      where: { id: operational.id },
      data: { role: entry.operationalRole, updated_at: new Date() },
    });
    console.log(
      `  Promoted ${entry.operationalUsername}: ${operational.role} -> ${entry.operationalRole}`,
    );
    operational = { ...operational, role: entry.operationalRole };
  } else if (!entry.operationalRole && operational.role === 'EMPLOYEE') {
    throw new Error(
      `${entry.operationalUsername} is EMPLOYEE role — set operationalRole or use a separate operational login`,
    );
  }

  const profile = await prisma.employee_profiles.findFirst({
    where: { employee_code: entry.employeeCode },
  });
  if (!profile) {
    throw new Error(`Employee profile not found: ${entry.employeeCode}`);
  }

  const otherProfileOnOperational = await prisma.employee_profiles.findFirst({
    where: { user_id: operational.id, NOT: { id: profile.id } },
  });
  if (otherProfileOnOperational) {
    throw new Error(
      `Operational user ${entry.operationalUsername} already linked to another profile ` +
        `(${otherProfileOnOperational.employee_code})`,
    );
  }

  const previousUserId = profile.user_id;
  await prisma.employee_profiles.update({
    where: { id: profile.id },
    data: { user_id: operational.id },
  });
  console.log(
    `  Linked ${entry.employeeCode} -> ${entry.operationalUsername} (${operational.role})` +
      (previousUserId && previousUserId !== operational.id
        ? ` [was user_id ${previousUserId}]`
        : previousUserId === operational.id
          ? ' [already linked]'
          : ''),
  );

  for (const key of SELF_PERMS) {
    await grantPermission(operational.id, key);
    console.log(`  Granted ${key}`);
  }

  if (!entry.employeesUsername) {
    console.log('  No separate EMPLOYEE login to deactivate (same-account dual-hat).');
    return;
  }

  const employeesLogin = await prisma.users.findUnique({
    where: { username: entry.employeesUsername },
  });
  if (!employeesLogin) {
    throw new Error(`EMPLOYEE login not found: ${entry.employeesUsername}`);
  }

  if (employeesLogin.id === operational.id) {
    console.log('  EMPLOYEE login is the same account — no deactivation needed.');
    return;
  }

  if (employeesLogin.is_active) {
    await prisma.users.update({
      where: { id: employeesLogin.id },
      data: { is_active: false, updated_at: new Date() },
    });
    console.log(`  Deactivated EMPLOYEE login: ${entry.employeesUsername}`);
  } else {
    console.log(`  EMPLOYEE login already inactive: ${entry.employeesUsername}`);
  }
}

async function main() {
  const filter = process.argv[2]?.trim();
  const entries = filter
    ? MERGES.filter((e) => e.operationalUsername === filter)
    : MERGES;

  if (entries.length === 0) {
    console.error(`No merge entry for operational username: ${filter}`);
    process.exit(1);
  }

  await ensureSeedActor();

  for (const entry of entries) {
    await mergeOne(entry);
  }

  console.log('\nDone. Affected users should re-login on mobile with their operational account.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
