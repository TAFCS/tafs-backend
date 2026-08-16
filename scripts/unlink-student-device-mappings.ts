/**
 * Unlinks (sets is_active = false) a fixed list of device_user_mappings rows —
 * the gr_number-mistake mappings that already have a correct cc-based mapping
 * elsewhere, so they're redundant/wrong and should stop being treated as a
 * live device enrollment. Matches the app's existing convention (see
 * zk-attendance-mapping.service.ts) where "unlink" means is_active=false,
 * not a hard delete — keeps the audit trail.
 *
 * Usage: npx ts-node scripts/unlink-student-device-mappings.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MAPPING_IDS = [
  285, 318, 325, 309, 211, 247, 282, 293, 283, 267, 278, 243, 214, 300, 126,
  394, 386, 312, 405, 400, 270, 416, 396, 333, 460, 465,
];

async function main() {
  const before = await prisma.device_user_mappings.findMany({
    where: { id: { in: MAPPING_IDS } },
    select: { id: true, student_cc: true, device_pin: true, device_sn: true, is_active: true },
  });

  const foundIds = new Set(before.map((m) => m.id));
  const missing = MAPPING_IDS.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    console.log('WARNING — these mapping IDs were not found:', missing);
  }

  const alreadyInactive = before.filter((m) => !m.is_active).length;
  console.log(`Found ${before.length} of ${MAPPING_IDS.length} requested rows (${alreadyInactive} already inactive).`);

  const result = await prisma.device_user_mappings.updateMany({
    where: { id: { in: MAPPING_IDS } },
    data: { is_active: false },
  });

  console.log(`Unlinked (is_active=false) ${result.count} row(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
