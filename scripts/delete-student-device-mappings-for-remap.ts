/**
 * Hard-deletes a fixed list of device_user_mappings rows so they can be
 * re-mapped from scratch. Only touches device_user_mappings — does NOT
 * touch zk_attendance_scans, zk_push_logs, or any other device log table.
 *
 * Usage: npx ts-node scripts/delete-student-device-mappings-for-remap.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MAPPING_IDS = [
  315, 971, 285, 517, 297, 318, 194, 325, 321, 199, 309, 302, 145, 158, 152,
  211, 489, 247, 511, 170, 282, 649, 246, 293, 515, 283, 746, 189, 267, 278,
  780, 210, 243, 764, 310, 488, 767, 214, 825, 300, 706, 225, 272, 513, 710,
  200, 126, 394, 678, 353, 563, 350, 386, 674, 312, 785, 419, 379, 405, 890,
  475, 400, 645, 399, 270, 856, 392, 453, 446, 466, 269, 337, 416, 577, 396,
  724, 215, 333, 289, 389, 460, 734, 465, 747, 468, 433, 431,
];

async function main() {
  const uniqueIds = [...new Set(MAPPING_IDS)];
  console.log(`Requested ${MAPPING_IDS.length} IDs (${uniqueIds.length} unique).`);

  const before = await prisma.device_user_mappings.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, student_cc: true, students: { select: { full_name: true } } },
  });
  const foundIds = new Set(before.map((m) => m.id));
  const alreadyGone = uniqueIds.filter((id) => !foundIds.has(id));

  console.log(`Currently exist: ${before.length}. Already gone (previously deleted): ${alreadyGone.length}.`);

  const result = await prisma.device_user_mappings.deleteMany({
    where: { id: { in: uniqueIds } },
  });

  console.log(`Deleted ${result.count} row(s) from device_user_mappings.`);
  console.log('zk_attendance_scans / zk_push_logs / zk_pin_name_hints were NOT touched.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
