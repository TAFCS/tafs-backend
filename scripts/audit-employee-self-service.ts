/**
 * Lists staff who are on payroll but need self-service setup for one-login access.
 *
 * Usage: npx ts-node scripts/audit-employee-self-service.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SELF_PERMS = ['attendance.self.view', 'payroll.self.view'] as const;

async function userHasSelfPerms(userId: string): Promise<boolean> {
  const rows = await prisma.user_permissions.findMany({
    where: {
      user_id: userId,
      granted: true,
      permissions: { key: { in: [...SELF_PERMS] } },
    },
    select: { permissions: { select: { key: true } } },
  });
  const keys = new Set(rows.map((r) => r.permissions.key));
  return SELF_PERMS.every((k) => keys.has(k));
}

async function main() {
  const onPayroll = await prisma.employee_profiles.findMany({
    where: { monthly_pay: { not: null } },
    select: {
      id: true,
      full_name: true,
      employee_code: true,
      campus_id: true,
      user_id: true,
      users: { select: { id: true, username: true, role: true, is_active: true } },
    },
    orderBy: { full_name: 'asc' },
  });

  const needsLink: typeof onPayroll = [];
  const needsPermissions: typeof onPayroll = [];
  const readyDualHat: typeof onPayroll = [];
  const duplicateEmployeesLogin: typeof onPayroll = [];

  for (const emp of onPayroll) {
    if (!emp.user_id || !emp.users) {
      needsLink.push(emp);
      continue;
    }
    if (emp.users.role === 'EMPLOYEE') {
      duplicateEmployeesLogin.push(emp);
      continue;
    }
    if (await userHasSelfPerms(emp.users.id)) {
      readyDualHat.push(emp);
    } else {
      needsPermissions.push(emp);
    }
  }

  console.log('=== On payroll, no login linked ===');
  if (needsLink.length === 0) {
    console.log('(none)');
  }
  for (const e of needsLink) {
    console.log(`- ${e.employee_code ?? e.id} ${e.full_name} (campus ${e.campus_id})`);
  }

  console.log('\n=== Ready — operational login + self-service permissions ===');
  if (readyDualHat.length === 0) {
    console.log('(none yet)');
  }
  for (const e of readyDualHat) {
    console.log(
      `- ${e.employee_code ?? e.id} ${e.full_name} -> ${e.users?.username} (${e.users?.role})`,
    );
  }

  console.log('\n=== Operational login linked — grant attendance.self.view + payroll.self.view ===');
  if (needsPermissions.length === 0) {
    console.log('(none)');
  }
  for (const e of needsPermissions) {
    console.log(
      `- ${e.employee_code ?? e.id} ${e.full_name} -> ${e.users?.username} (${e.users?.role})`,
    );
  }
  if (needsPermissions.length > 0) {
    console.log(
      '\nRun: npx ts-node scripts/grant-employee-self-service.ts' +
        (needsPermissions.length === 1 ? ` ${needsPermissions[0].users?.username}` : ''),
    );
  }

  console.log('\n=== Linked to EMPLOYEE-only login (works today; merge when convenient) ===');
  console.log(`Count: ${duplicateEmployeesLogin.length}`);
  for (const e of duplicateEmployeesLogin.slice(0, 5)) {
    console.log(`- ${e.employee_code ?? e.id} ${e.full_name} -> ${e.users?.username}`);
  }
  if (duplicateEmployeesLogin.length > 5) {
    console.log(`  ... and ${duplicateEmployeesLogin.length - 5} more`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
