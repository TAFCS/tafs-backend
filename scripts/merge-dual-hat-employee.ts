/**
 * Links an employee profile to an operational login, grants self-service
 * permissions, and deactivates the duplicate EMPLOYEE login.
 *
 * Usage:
 *   npx ts-node scripts/merge-dual-hat-employee.ts
 *   npx ts-node scripts/merge-dual-hat-employee.ts sara.naqvi
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SELF_PERMS = ['attendance.self.view', 'payroll.self.view'] as const;
const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

type MergeEntry = {
  employeeCode: string;
  operationalUsername: string;
  employeesUsername: string;
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

  const operational = await prisma.users.findUnique({
    where: { username: entry.operationalUsername },
  });
  if (!operational) {
    throw new Error(`Operational user not found: ${entry.operationalUsername}`);
  }
  if (operational.role === 'EMPLOYEE') {
    throw new Error(`${entry.operationalUsername} is EMPLOYEE role — expected operational account`);
  }

  const employeesLogin = await prisma.users.findUnique({
    where: { username: entry.employeesUsername },
  });
  if (!employeesLogin) {
    throw new Error(`EMPLOYEE login not found: ${entry.employeesUsername}`);
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
      (previousUserId ? ` [was user_id ${previousUserId}]` : ''),
  );

  for (const key of SELF_PERMS) {
    await grantPermission(operational.id, key);
    console.log(`  Granted ${key}`);
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
