/**
 * Idempotent staff roster seed — creates users, assigns campuses/class bands,
 * and applies permission overrides per the TAFS access matrix.
 *
 * Usage: npx ts-node scripts/seed-staff-roster.ts
 * Prerequisite: npx ts-node scripts/seed-permissions.ts
 */
import { PrismaClient, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { CLASS_BAND_IDS as CLASS } from '../src/common/class-band-ids';

const prisma = new PrismaClient();

const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

type RosterEntry = {
  username: string;
  full_name: string;
  role: StaffRole;
  campus_id: number | null;
  allowed_class_ids?: number[];
  grant_permissions?: string[];
  revoke_permissions?: string[];
};

const ROSTER: RosterEntry[] = [
  // SUPER_ADMIN — all campuses
  { username: 'muhammad.hussain.mirza', full_name: 'Muhammad Hussain Mirza', role: 'SUPER_ADMIN', campus_id: null },
  { username: 'muhammad.hassan.mirza', full_name: 'Muhammad Hassan Mirza', role: 'SUPER_ADMIN', campus_id: null },
  { username: 'asad.hussain.mirza', full_name: 'Asad Hussain Mirza', role: 'SUPER_ADMIN', campus_id: null },

  // CAMPUS_ADMIN — all campuses
  { username: 'asifa.soomro', full_name: 'Asifa Soomro', role: 'CAMPUS_ADMIN', campus_id: null },

  // GENERAL_RESPONDENT — triage desk for general non-child queries
  { username: 'general.respondent', full_name: 'General Query Desk', role: 'GENERAL_RESPONDENT', campus_id: null },

  // PRINCIPAL
  { username: 'samia.abbas', full_name: 'Samia Abbas', role: 'PRINCIPAL', campus_id: 2, allowed_class_ids: [] },
  { username: 'ferwa.sabir', full_name: 'Ferwa Sabir', role: 'PRINCIPAL', campus_id: 3, allowed_class_ids: [] },
  { username: 'sukaina.osama', full_name: 'Sukaina Osama', role: 'PRINCIPAL', campus_id: 1, allowed_class_ids: CLASS.PN_KG },
  { username: 'lana.principal', full_name: 'Lana', role: 'PRINCIPAL', campus_id: 1, allowed_class_ids: CLASS.JR_12 },
  { username: 'anita.principal', full_name: 'Anita', role: 'PRINCIPAL', campus_id: 1, allowed_class_ids: CLASS.JR_35 },
  { username: 'sara.naqvi', full_name: 'Sara Naqvi', role: 'PRINCIPAL', campus_id: 1, allowed_class_ids: CLASS.SR_13 },
  { username: 'hira.khadim', full_name: 'Hira Khadim', role: 'PRINCIPAL', campus_id: 1, allowed_class_ids: CLASS.VI_X },
  { username: 'syed.komail.hassan', full_name: 'Syed Komail Hassan', role: 'PRINCIPAL', campus_id: 1, allowed_class_ids: CLASS.OA },

  // SUPER_ADMIN — Fozia Hussain (all campuses)
  {
    username: 'fozia.hussain',
    full_name: 'Fozia Hussain',
    role: 'SUPER_ADMIN',
    campus_id: null,
  },
  // FINANCE_CLERK — institution-wide + editor overrides for Nimla
  {
    username: 'nimla.asad',
    full_name: 'Nimla Asad',
    role: 'FINANCE_CLERK',
    campus_id: null,
    grant_permissions: ['students.directory.edit', 'students.registration.view'],
  },
  {
    username: 'mrs.adil',
    full_name: 'Mrs. Adil',
    role: 'FINANCE_CLERK',
    campus_id: null,
    revoke_permissions: [
      'finance.vouchers.generate_single',
      'finance.vouchers.generate_bulk',
      'finance.vouchers.split_partial',
      'finance.deposits.record',
    ],
  },

  // RECEPTIONIST — 3 per campus
  ...([1, 2, 3] as const).flatMap((campusId) =>
    [1, 2, 3].map((n) => {
      const codes = ['jhr', 'knf', 'nnz'] as const;
      return {
        username: `reception.${codes[campusId - 1]}.${n}`,
        full_name: `Receptionist ${codes[campusId - 1].toUpperCase()} ${n}`,
        role: 'RECEPTIONIST' as StaffRole,
        campus_id: campusId,
      };
    }),
  ),
];

function generatePassword(): string {
  return randomBytes(9).toString('base64url').slice(0, 12);
}

async function ensureSeedActor(): Promise<void> {
  const existing = await prisma.users.findUnique({ where: { id: SEED_ACTOR_ID } });
  if (existing) return;
  const hash = await bcrypt.hash('seed-actor-internal', 10);
  await prisma.users.create({
    data: {
      id: SEED_ACTOR_ID,
      username: '_seed_actor',
      full_name: 'Seed Actor',
      password_hash: hash,
      role: 'SUPER_ADMIN',
      is_active: false,
      created_at: new Date(),
      updated_at: new Date(),
    },
  });
}

async function applyPermissionOverrides(
  userId: string,
  entry: RosterEntry,
): Promise<void> {
  const grants = entry.grant_permissions ?? [];
  const revokes = entry.revoke_permissions ?? [];

  for (const key of [...grants, ...revokes]) {
    const permission = await prisma.permissions.findUnique({ where: { key } });
    if (!permission) {
      console.warn(`  Permission not found: ${key}`);
      continue;
    }
    const granted = grants.includes(key);
    await prisma.user_permissions.upsert({
      where: {
        user_id_permission_id: { user_id: userId, permission_id: permission.id },
      },
      update: {
        granted,
        granted_by: SEED_ACTOR_ID,
        granted_at: new Date(),
        note: 'seed-staff-roster',
      },
      create: {
        user_id: userId,
        permission_id: permission.id,
        granted,
        granted_by: SEED_ACTOR_ID,
        granted_at: new Date(),
        note: 'seed-staff-roster',
      },
    });
  }
}

async function upsertStaff(entry: RosterEntry, password: string): Promise<'created' | 'updated'> {
  const hash = await bcrypt.hash(password, 10);
  const now = new Date();
  const allowed = entry.allowed_class_ids ?? [];

  const existing = await prisma.users.findUnique({
    where: { username: entry.username },
  });

  if (existing) {
    await prisma.users.update({
      where: { id: existing.id },
      data: {
        full_name: entry.full_name,
        role: entry.role,
        campus_id: entry.campus_id,
        allowed_class_ids: allowed,
        password_hash: hash,
        is_active: true,
        updated_at: now,
      },
    });
    await applyPermissionOverrides(existing.id, entry);
    return 'updated';
  }

  const id = uuidv4();
  await prisma.users.create({
    data: {
      id,
      username: entry.username,
      full_name: entry.full_name,
      password_hash: hash,
      role: entry.role,
      campus_id: entry.campus_id,
      allowed_class_ids: allowed,
      is_active: true,
      created_at: now,
      updated_at: now,
    },
  });
  await applyPermissionOverrides(id, entry);
  return 'created';
}

async function main() {
  console.log('Seeding staff roster...\n');
  await ensureSeedActor();

  const credentials: { username: string; password: string; role: string; full_name: string }[] = [];

  for (const entry of ROSTER) {
    const password = generatePassword();
    const action = await upsertStaff(entry, password);
    credentials.push({
      username: entry.username,
      password,
      role: entry.role,
      full_name: entry.full_name,
    });
    console.log(`  [${action}] ${entry.username} (${entry.role})`);
  }

  const outPath = path.join(__dirname, 'seed-staff-roster-credentials.csv');
  const header = 'username,password,role,full_name\n';
  const rows = credentials
    .map((c) => `${c.username},${c.password},${c.role},"${c.full_name}"`)
    .join('\n');
  fs.writeFileSync(outPath, header + rows + '\n', 'utf8');

  console.log(`\nDone. ${ROSTER.length} accounts processed.`);
  console.log(`Credentials written to: ${outPath}`);
  console.log('Store this file securely and distribute passwords to staff.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
