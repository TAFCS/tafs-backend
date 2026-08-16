/**
 * Hard-deletes device_user_mappings rows (student mappings only). For every
 * student with more than one mapping row (active or inactive), keeps only
 * the row whose device_pin equals their cc; deletes every other row for
 * that student. If none of a student's rows match their cc, deletes all of
 * them, leaving no mapping behind.
 *
 * Groups where MORE THAN ONE row already matches cc (i.e. legitimate
 * multi-device enrollments, not mistakes) are left untouched and reported
 * separately — deleting one arbitrarily could break that student's
 * attendance on a working physical device.
 *
 * This only touches device_user_mappings — no other table.
 *
 * Usage: npx ts-node scripts/wipe-duplicate-student-device-mappings.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const mappings = await prisma.device_user_mappings.findMany({
    where: { student_cc: { not: null } },
    select: {
      id: true,
      device_sn: true,
      device_pin: true,
      is_active: true,
      student_cc: true,
      students: { select: { full_name: true, gr_number: true } },
    },
  });

  const byStudent = new Map<number, typeof mappings>();
  for (const m of mappings) {
    if (m.student_cc == null) continue;
    const list = byStudent.get(m.student_cc) ?? [];
    list.push(m);
    byStudent.set(m.student_cc, list);
  }

  const dupGroups = [...byStudent.entries()].filter(([, list]) => list.length > 1);

  const toDelete: number[] = [];
  const skippedAmbiguous: { cc: number; name: string; rows: typeof mappings }[] = [];

  for (const [cc, list] of dupGroups) {
    const matches = list.filter((m) => m.device_pin.trim() === String(cc));
    if (matches.length === 0) {
      // No correct mapping at all — wipe every row for this student.
      toDelete.push(...list.map((m) => m.id));
    } else if (matches.length === 1) {
      // Keep the one correct mapping, delete the rest.
      toDelete.push(...list.filter((m) => m.id !== matches[0].id).map((m) => m.id));
    } else {
      // Multiple rows already match cc (different devices) — ambiguous, skip.
      skippedAmbiguous.push({ cc, name: list[0].students?.full_name ?? '', rows: list });
    }
  }

  console.log(`Duplicate groups: ${dupGroups.length}`);
  console.log(`Rows to delete: ${toDelete.length}`);
  console.log(`Ambiguous groups skipped (multiple rows already match cc): ${skippedAmbiguous.length}`);
  for (const g of skippedAmbiguous) {
    console.log(
      `  cc=${g.cc} ${g.name}: ${g.rows.map((r) => `#${r.id} pin=${r.device_pin} sn=${r.device_sn} active=${r.is_active}`).join(' | ')}`,
    );
  }

  const result = await prisma.device_user_mappings.deleteMany({
    where: { id: { in: toDelete } },
  });

  console.log(`\nDeleted ${result.count} row(s) from device_user_mappings.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
