/**
 * Read-only diagnostic for GKF (campus_id=2) GR sequence issues.
 * Usage: npx ts-node scripts/diagnose-gkf-gr-sequence.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const top = await prisma.$queryRaw<
    Array<{ cc: number; full_name: string; status: string; gr_number: string; deleted_at: Date | null }>
  >`
    SELECT cc, full_name, status, gr_number, deleted_at
    FROM students
    WHERE campus_id = 2
      AND gr_number ~ '^KF-A[0-9]+$'
    ORDER BY CAST(SUBSTRING(gr_number FROM 'KF-A([0-9]+)$') AS INTEGER) DESC
    LIMIT 10
  `;
  console.log('=== Top KF-A suffixes at GKF ===');
  console.table(top);

  const known = await prisma.students.findMany({
    where: { campus_id: 2, cc: { in: [8102, 8103] } },
    select: { cc: true, full_name: true, status: true, gr_number: true, deleted_at: true },
  });
  console.log('\n=== CC 8102 / 8103 ===');
  console.table(known);

  const blocking = await prisma.$queryRaw<
    Array<{ cc: number; full_name: string; status: string; gr_number: string; deleted_at: Date | null }>
  >`
    SELECT cc, full_name, status, gr_number, deleted_at
    FROM students
    WHERE campus_id = 2
      AND gr_number BETWEEN 'KF-A118' AND 'KF-A999'
    ORDER BY gr_number
    LIMIT 20
  `;
  console.log('\n=== Records occupying KF-A118..KF-A999 (first 20) ===');
  console.table(blocking);

  const bare = await prisma.$queryRaw<
    Array<{ cc: number; full_name: string; gr_number: string; status: string; deleted_at: Date | null }>
  >`
    SELECT cc, full_name, gr_number, status, deleted_at
    FROM students
    WHERE campus_id = 2 AND gr_number ~ '^[0-9]+$'
    ORDER BY gr_number::integer DESC
    LIMIT 10
  `;
  console.log('\n=== Bare numeric GRs (no prefix) ===');
  console.table(bare);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
