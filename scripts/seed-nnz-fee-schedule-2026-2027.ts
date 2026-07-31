/**
 * Insert North Nazimabad (NNZ) class_fee_schedule for academic year 2026-2027
 * from the FSP fee structure sheet.
 *
 * - Classes: PN → JR-V only
 * - Admission / Caution: list prices (FSP waiver applied outside schedule)
 * - Monthly: revised (post-strikethrough) amounts from the sheet
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CAMPUS_ID = 3; // NNZ
const ACADEMIC_YEAR = '2026-2027';

const FEE = {
  MONTHLY: 1,
  ADMISSION: 2,
  CAUTION: 3,
  ANNUAL: 4,
  REGISTRATION: 6,
} as const;

// PN → JR-V share the same amounts on the sheet
const PN_TO_JRV = [1, 2, 3, 4, 5, 6, 7, 8];

const AMOUNTS = {
  [FEE.REGISTRATION]: 19975,
  [FEE.ADMISSION]: 59925,
  [FEE.CAUTION]: 39950,
  [FEE.ANNUAL]: 19975,
  [FEE.MONTHLY]: 13975,
};

async function main() {
  const existing = await prisma.class_fee_schedule.count({
    where: { campus_id: CAMPUS_ID, academic_year: ACADEMIC_YEAR },
  });
  if (existing > 0) {
    console.log(
      `Found ${existing} existing row(s) for NNZ ${ACADEMIC_YEAR} — deleting before insert.`,
    );
    await prisma.class_fee_schedule.deleteMany({
      where: { campus_id: CAMPUS_ID, academic_year: ACADEMIC_YEAR },
    });
  }

  const rows = PN_TO_JRV.flatMap((class_id) =>
    (Object.entries(AMOUNTS) as [string, number][]).map(([fee_id, amount]) => ({
      class_id,
      fee_id: Number(fee_id),
      amount,
      campus_id: CAMPUS_ID,
      academic_year: ACADEMIC_YEAR,
    })),
  );

  const result = await prisma.class_fee_schedule.createMany({ data: rows });
  console.log(`Inserted ${result.count} row(s) for NNZ ${ACADEMIC_YEAR}.`);

  const verify = await prisma.class_fee_schedule.findMany({
    where: { campus_id: CAMPUS_ID, academic_year: ACADEMIC_YEAR, class_id: 1 },
    include: { fee_types: { select: { description: true } } },
    orderBy: { fee_id: 'asc' },
  });
  console.log('\nPN (class_id=1) verification:');
  for (const r of verify) {
    console.log(`  ${r.fee_types.description}: ${Number(r.amount).toLocaleString()}`);
  }
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
