/**
 * Grant the same student attendance-marking access as ASIA MUJEEB
 * (attendance.student.rollcall.mark + .view), scoped to one campus each.
 *
 * Asia's live overrides (for reference):
 *   attendance.student.rollcall.mark
 *   attendance.student.rollcall.view
 *   academic.campuses.view  ← all-campus; NOT granted here
 *
 * Usage: npx ts-node scripts/grant-attendance-mark-campus-scoped.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000001';
const NOTE = 'Campus-scoped attendance marking (same as asia.mujeeb mark/view)';

const PERMS = [
  'attendance.student.rollcall.mark',
  'attendance.student.rollcall.view',
] as const;

/** Campus IDs: 1=Johar (JOHAR/GEJ), 2=Kaneez Fatima (GKF), 3=North Nazimabad (NNN) */
const TARGETS: Array<{ username: string; campus_id: number; label: string }> = [
  { username: 's.amir', campus_id: 1, label: 'Sultana Amir (JOHAR)' },
  { username: 'samreen.ali', campus_id: 1, label: 'Samreen Ali (JOHAR)' },
  { username: 'syeda.anita', campus_id: 1, label: 'Syeda Anita (JOHAR)' },
  { username: 'sana.zaka', campus_id: 1, label: 'Sana Zaka (JOHAR)' },
  { username: 'jasmine.nusrat', campus_id: 1, label: 'Jasmine Nusrat (JOHAR)' },
  { username: 'rehmat.kamran', campus_id: 1, label: 'Rehmat Kamran (JOHAR)' },
  { username: 'hira.khadim', campus_id: 1, label: 'Hira Khadim (JOHAR)' },
  { username: 'mishal.rehan', campus_id: 1, label: 'Mishal Rehan (JOHAR)' },
  { username: 'ferwa.sabir', campus_id: 3, label: 'Ferwa Sabir (NNN)' },
  { username: 'ayesha.shahrukh', campus_id: 2, label: 'Ayesha Shahrukh (GKF)' },
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

async function grantPermission(userId: string, permissionKey: string): Promise<'granted' | 'already'> {
  const permission = await prisma.permissions.findUnique({ where: { key: permissionKey } });
  if (!permission) throw new Error(`Permission not found: ${permissionKey}`);

  const existing = await prisma.user_permissions.findUnique({
    where: { user_id_permission_id: { user_id: userId, permission_id: permission.id } },
  });
  if (existing?.granted === true) return 'already';

  await prisma.user_permissions.upsert({
    where: { user_id_permission_id: { user_id: userId, permission_id: permission.id } },
    update: {
      granted: true,
      granted_by: SEED_ACTOR_ID,
      granted_at: new Date(),
      note: NOTE,
    },
    create: {
      user_id: userId,
      permission_id: permission.id,
      granted: true,
      granted_by: SEED_ACTOR_ID,
      granted_at: new Date(),
      note: NOTE,
    },
  });
  return 'granted';
}

async function main() {
  await ensureSeedActor();

  for (const target of TARGETS) {
    const user = await prisma.users.findUnique({
      where: { username: target.username },
      select: {
        id: true,
        username: true,
        full_name: true,
        role: true,
        campus_id: true,
        is_active: true,
      },
    });

    if (!user) {
      console.log(`MISS  ${target.label} — no user "${target.username}"`);
      continue;
    }
    if (!user.is_active) {
      console.log(`SKIP  ${target.label} (${target.username}) — inactive`);
      continue;
    }

    const campusBefore = user.campus_id;
    if (user.campus_id !== target.campus_id) {
      await prisma.users.update({
        where: { id: user.id },
        data: { campus_id: target.campus_id, updated_at: new Date() },
      });
    }

    const permResults: string[] = [];
    for (const key of PERMS) {
      permResults.push(`${key}=${await grantPermission(user.id, key)}`);
    }

    console.log(
      `OK    ${target.label} | ${user.username} | role=${user.role} | campus ${campusBefore ?? 'null'}→${target.campus_id} | ${permResults.join(', ')}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
