/**
 * Regenerates passwords for all real EMPLOYEE-role logins linked to employee
 * profiles, creates EMPLOYEE accounts for profiles that still have no login,
 * and writes a plaintext credentials CSV.
 *
 * Excludes: TEST-* codes, @tafs.com junk users, dual-hat profiles linked to
 * non-EMPLOYEE roles (PRINCIPAL / SUPER_ADMIN / FINANCE_CLERK).
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/export-employee-credentials.ts
 *   DRY_RUN=false npx ts-node --transpile-only scripts/export-employee-credentials.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const OUT_PATH = path.join(
  __dirname,
  '..',
  'staff-data',
  'cleaned',
  'employee-credentials-all.csv',
);

const prisma = new PrismaClient();

function generatePassword(): string {
  return randomBytes(9).toString('base64url').slice(0, 12);
}

const HONORIFIC_PREFIX = /^(MR\.?|MRS\.?|MS\.?|M\.|SIR\.?|SYED\.?|SYEDA\.?)\s*/i;

function buildUsername(fullName: string, employeeCode: string, taken: Set<string>): string {
  let name = fullName.trim().replace(HONORIFIC_PREFIX, '').trim();
  name = name.replace(/\s*-\s*/g, ' ');
  const tokens = name.split(/\s+/).filter(Boolean);

  let base: string;
  if (tokens.length >= 2) {
    const first = tokens[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const last = tokens[tokens.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
    base = `${first}.${last}`;
  } else if (tokens.length === 1) {
    base = tokens[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  } else {
    base = 'employee';
  }

  if (!base) base = 'employee';

  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  const suffix = employeeCode.replace(/\D/g, '').slice(-4) || String(taken.size);
  let withSuffix = `${base}.${suffix}`;
  let n = 2;
  while (taken.has(withSuffix)) {
    withSuffix = `${base}.${suffix}.${n++}`;
  }
  taken.add(withSuffix);
  return withSuffix;
}

type CredRow = {
  employee_code: string;
  full_name: string;
  username: string;
  password: string;
  role: string;
  is_active: boolean;
  action: 'password_reset' | 'account_created';
};

async function main() {
  const allUsernames = await prisma.users.findMany({ select: { username: true } });
  const taken = new Set(allUsernames.map((u) => u.username));

  const existingEmployeeLogins = await prisma.users.findMany({
    where: {
      role: StaffRole.EMPLOYEE,
      employee_profile: { isNot: null },
    },
    select: {
      id: true,
      username: true,
      is_active: true,
      employee_profile: {
        select: { id: true, employee_code: true, full_name: true },
      },
    },
    orderBy: { username: 'asc' },
  });

  const toReset = existingEmployeeLogins.filter((u) => {
    const code = u.employee_profile?.employee_code;
    if (!code || code.startsWith('TEST-')) return false;
    if (u.username.includes('@tafs.com')) return false;
    return true;
  });

  const profilesNoLogin = await prisma.employee_profiles.findMany({
    where: {
      employee_code: { not: null },
      user_id: null,
      NOT: { employee_code: { startsWith: 'TEST-' } },
    },
    select: {
      id: true,
      employee_code: true,
      full_name: true,
      campus_id: true,
    },
    orderBy: { employee_code: 'asc' },
  });

  const credentials: CredRow[] = [];

  console.log(`DRY_RUN=${DRY_RUN}`);
  console.log(`Will reset passwords: ${toReset.length}`);
  console.log(`Will create accounts: ${profilesNoLogin.length}`);
  console.log(`Total credentials to export: ${toReset.length + profilesNoLogin.length}`);

  for (const user of toReset) {
    const password = generatePassword();
    const hash = await bcrypt.hash(password, 10);
    if (!DRY_RUN) {
      await prisma.users.update({
        where: { id: user.id },
        data: { password_hash: hash },
      });
    }
    credentials.push({
      employee_code: user.employee_profile!.employee_code!,
      full_name: user.employee_profile!.full_name ?? user.username,
      username: user.username,
      password,
      role: 'EMPLOYEE',
      is_active: user.is_active,
      action: 'password_reset',
    });
  }

  for (const profile of profilesNoLogin) {
    const code = profile.employee_code!;
    const fullName = profile.full_name ?? code;
    const username = buildUsername(fullName, code, taken);
    const password = generatePassword();
    const hash = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    if (!DRY_RUN) {
      await prisma.users.create({
        data: {
          id: userId,
          username,
          full_name: fullName,
          password_hash: hash,
          role: StaffRole.EMPLOYEE,
          campus_id: profile.campus_id ?? 1,
          is_active: true,
        },
      });
      await prisma.employee_profiles.update({
        where: { id: profile.id },
        data: { user_id: userId },
      });
    }

    credentials.push({
      employee_code: code,
      full_name: fullName,
      username,
      password,
      role: 'EMPLOYEE',
      is_active: true,
      action: 'account_created',
    });
  }

  credentials.sort((a, b) => a.employee_code.localeCompare(b.employee_code));

  const header = 'employee_code,full_name,username,password,role,is_active,action\n';
  const body = credentials
    .map((c) => {
      const name = `"${c.full_name.replace(/"/g, '""')}"`;
      return `${c.employee_code},${name},${c.username},${c.password},${c.role},${c.is_active},${c.action}`;
    })
    .join('\n');

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, header + body + '\n', 'utf8');
    console.log(`\nWrote ${credentials.length} rows -> ${OUT_PATH}`);
  } else {
    console.log('\nDRY RUN — no DB writes / no CSV written.');
    console.log('Re-run with DRY_RUN=false to apply.');
    console.log(`\nPreview first 5:`);
    for (const c of credentials.slice(0, 5)) {
      console.log(`${c.employee_code} | ${c.username} | ${c.action} | active=${c.is_active}`);
    }
  }

  const created = credentials.filter((c) => c.action === 'account_created').length;
  const reset = credentials.filter((c) => c.action === 'password_reset').length;
  const inactive = credentials.filter((c) => !c.is_active).length;
  console.log(JSON.stringify({ total: credentials.length, reset, created, inactive }, null, 2));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
