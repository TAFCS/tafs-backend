/**
 * Grants attendance.self.view + payroll.self.view to operational logins
 * linked to employee_profiles (dual-hat staff).
 *
 * Usage:
 *   npx ts-node scripts/grant-employee-self-service.ts           # all linked operational users
 *   npx ts-node scripts/grant-employee-self-service.ts hira.khadim  # one username
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SELF_PERMS = ['attendance.self.view', 'payroll.self.view'] as const;
const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

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

async function grantPermission(userId: string, permissionKey: string): Promise<'granted' | 'already'> {
  const permission = await prisma.permissions.findUnique({ where: { key: permissionKey } });
  if (!permission) {
    throw new Error(`Permission not found: ${permissionKey}`);
  }

  const existing = await prisma.user_permissions.findUnique({
    where: {
      user_id_permission_id: { user_id: userId, permission_id: permission.id },
    },
  });

  if (existing?.granted === true) {
    return 'already';
  }

  await prisma.user_permissions.upsert({
    where: {
      user_id_permission_id: { user_id: userId, permission_id: permission.id },
    },
    update: {
      granted: true,
      granted_by: SEED_ACTOR_ID,
      granted_at: new Date(),
      note: 'grant-employee-self-service',
    },
    create: {
      user_id: userId,
      permission_id: permission.id,
      granted: true,
      granted_by: SEED_ACTOR_ID,
      granted_at: new Date(),
      note: 'grant-employee-self-service',
    },
  });

  return 'granted';
}

async function main() {
  const filterUsername = process.argv[2]?.trim();

  await ensureSeedActor();

  const onPayroll = await prisma.employee_profiles.findMany({
    where: {
      monthly_pay: { not: null },
      user_id: { not: null },
      users: filterUsername
        ? { username: filterUsername, is_active: true }
        : { is_active: true, role: { not: 'EMPLOYEE' } },
    },
    select: {
      employee_code: true,
      full_name: true,
      user_id: true,
      users: { select: { username: true, role: true } },
    },
    orderBy: { full_name: 'asc' },
  });

  if (onPayroll.length === 0) {
    console.log(
      filterUsername
        ? `No active payroll profile linked to username "${filterUsername}".`
        : 'No operational payroll profiles found.',
    );
    return;
  }

  for (const emp of onPayroll) {
    const userId = emp.user_id!;
    const username = emp.users!.username;
    console.log(`\n${emp.employee_code ?? '?'} ${emp.full_name} -> ${username} (${emp.users!.role})`);

    for (const key of SELF_PERMS) {
      const result = await grantPermission(userId, key);
      console.log(`  ${key}: ${result === 'granted' ? 'granted' : 'already had'}`);
    }
  }

  console.log('\nDone. Affected users should re-login on mobile for hasEmployeeProfile + permissions.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
