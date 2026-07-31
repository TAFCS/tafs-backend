/**
 * Insert Kaneez Fatima (KNF) class_fee_schedule for academic year 2026-2027
 * from the FSP fee structure sheet (Gulzar-e-Hijri Network).
 *
 * - Classes: PN → JR-V only
 * - Admission / Caution: list prices (FSP waiver applied outside schedule)
 * - Monthly: revised (post-strikethrough) amounts; JR-V differs from PN–JR-IV
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CAMPUS_ID = 2; // KNF
const ACADEMIC_YEAR = '2026-2027';

const FEE = {
  MONTHLY: 1,
  ADMISSION: 2,
  CAUTION: 3,
  ANNUAL: 4,
  REGISTRATION: 6,
} as const;

type Amounts = {
  registration: number;
  admission: number;
  caution: number;
  annual: number;
  monthly: number;
};

function rowsForClasses(classIds: number[], amounts: Amounts) {
  return classIds.flatMap((class_id) => [
    { class_id, fee_id: FEE.REGISTRATION, amount: amounts.registration },
    { class_id, fee_id: FEE.ADMISSION, amount: amounts.admission },
    { class_id, fee_id: FEE.CAUTION, amount: amounts.caution },
    { class_id, fee_id: FEE.ANNUAL, amount: amounts.annual },
    { class_id, fee_id: FEE.MONTHLY, amount: amounts.monthly },
  ]);
}

const PN_TO_JRIV = [1, 2, 3, 4, 5, 6, 7]; // PN → JR-IV
const JRV = [8];

const SHARED = {
  registration: 20975,
  admission: 62925,
  caution: 41950,
  annual: 20975,
};

async function main() {
  const existing = await prisma.class_fee_schedule.count({
    where: { campus_id: CAMPUS_ID, academic_year: ACADEMIC_YEAR },
  });
  if (existing > 0) {
    console.log(
      `Found ${existing} existing row(s) for KNF ${ACADEMIC_YEAR} — deleting before insert.`,
    );
    await prisma.class_fee_schedule.deleteMany({
      where: { campus_id: CAMPUS_ID, academic_year: ACADEMIC_YEAR },
    });
  }

  const data = [
    ...rowsForClasses(PN_TO_JRIV, { ...SHARED, monthly: 16975 }),
    ...rowsForClasses(JRV, { ...SHARED, monthly: 16575 }),
  ].map((row) => ({
    ...row,
    campus_id: CAMPUS_ID,
    academic_year: ACADEMIC_YEAR,
  }));

  const result = await prisma.class_fee_schedule.createMany({ data });
  console.log(`Inserted ${result.count} row(s) for KNF ${ACADEMIC_YEAR}.`);

  for (const classId of [1, 8]) {
    const verify = await prisma.class_fee_schedule.findMany({
      where: {
        campus_id: CAMPUS_ID,
        academic_year: ACADEMIC_YEAR,
        class_id: classId,
      },
      include: {
        classes: { select: { class_code: true } },
        fee_types: { select: { description: true } },
      },
      orderBy: { fee_id: 'asc' },
    });
    console.log(`\n${verify[0]?.classes.class_code}:`);
    for (const r of verify) {
      console.log(`  ${r.fee_types.description}: ${Number(r.amount).toLocaleString()}`);
    }
  }
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
