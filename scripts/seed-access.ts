import { PrismaClient, StaffRole } from '@prisma/client';
import { TILES_MANIFEST } from '../src/modules/access/tiles.manifest';

const prisma = new PrismaClient();

const PACK_META: Partial<Record<StaffRole, { name: string; description: string }>> = {
  CAMPUS_ADMIN: {
    name: 'Campus Admin',
    description: 'Campus-scoped administration matching the Campus Admin role',
  },
  PRINCIPAL: {
    name: 'Principal',
    description: 'Academic and staff oversight matching the Principal role',
  },
  FINANCE_CLERK: {
    name: 'Finance',
    description: 'Fee management and financial operations matching the Finance Clerk role',
  },
  RECEPTIONIST: {
    name: 'Reception',
    description: 'Registration and inquiries matching the Receptionist role',
  },
  TEACHER: {
    name: 'Teaching',
    description: 'Attendance and directory access matching the Teacher role',
  },
  STAFF_EDITOR: {
    name: 'Staff Editor',
    description: 'Student record editing matching the Staff Editor role',
  },
  GENERAL_RESPONDENT: {
    name: 'General Respondent',
    description: 'Support-ticket triage matching the General Respondent role',
  },
  EMPLOYEE: {
    name: 'Employee self-service',
    description: 'Own attendance, payroll and leave matching the Employee role',
  },
};

async function main() {
  console.log('Seeding system access packs from role_permissions…');

  const tiles = await prisma.access_tiles.findMany({
    where: { is_active: true },
    include: { capabilities: { include: { permission: { select: { key: true } } } } },
  });

  const catalog = tiles.length
    ? tiles.map((t) => ({
        id: t.id,
        capabilities: t.capabilities.map((c) => c.permission.key),
      }))
    : TILES_MANIFEST.map((t) => ({ id: t.id, capabilities: t.capabilities }));

  for (const [role, meta] of Object.entries(PACK_META) as [StaffRole, { name: string; description: string }][]) {
    const rolePerms = await prisma.role_permissions.findMany({
      where: { role },
      include: { permissions: { select: { key: true } } },
    });
    const roleKeys = new Set(rolePerms.map((rp) => rp.permissions.key));
    const tileIds = catalog
      .filter((t) => t.capabilities.length > 0 && t.capabilities.every((c) => roleKeys.has(c)))
      .map((t) => t.id);

    const pack = await prisma.access_packs.upsert({
      where: { name: meta.name },
      update: { description: meta.description, is_system: true },
      create: {
        name: meta.name,
        description: meta.description,
        is_system: true,
      },
    });

    await prisma.access_pack_tiles.deleteMany({
      where: { pack_id: pack.id, tile_id: { notIn: tileIds } },
    });
    if (tileIds.length > 0) {
      await prisma.access_pack_tiles.createMany({
        data: tileIds.map((tile_id) => ({ pack_id: pack.id, tile_id })),
        skipDuplicates: true,
      });
    }

    console.log(`  ${meta.name} (${role}): ${tileIds.length} tiles`);
  }

  console.log('Access pack seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
