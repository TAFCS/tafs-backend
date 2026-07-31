/**
 * Insert Gulistan-e-Johar (JHR) class_fee_schedule for academic year 2026-2027.
 *
 * - Cambridge: PN → O-III (from 2026-2027 fee structure sheet)
 * - Secondary: VI → X (amounts from secondary sheet; stored as 2026-2027)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CAMPUS_ID = 1; // JHR
const ACADEMIC_YEAR = '2026-2027';

const FEE = {
  MONTHLY: 1,
  ADMISSION: 2,
  CAUTION: 3,
  ANNUAL: 4,
  REGISTRATION: 6,
  RESOURCE: 7,
  CURRICULAR: 8,
} as const;

type FeeAmounts = {
  registration: number;
  admission: number;
  caution: number;
  annual: number;
  resource: number;
  curricular: number;
  monthly: number;
};

function rowsForClasses(classIds: number[], amounts: FeeAmounts) {
  return classIds.flatMap((class_id) => [
    { class_id, fee_id: FEE.REGISTRATION, amount: amounts.registration },
    { class_id, fee_id: FEE.ADMISSION, amount: amounts.admission },
    { class_id, fee_id: FEE.CAUTION, amount: amounts.caution },
    { class_id, fee_id: FEE.ANNUAL, amount: amounts.annual },
    { class_id, fee_id: FEE.RESOURCE, amount: amounts.resource },
    { class_id, fee_id: FEE.CURRICULAR, amount: amounts.curricular },
    { class_id, fee_id: FEE.MONTHLY, amount: amounts.monthly },
  ]);
}

// Cambridge — PN → O-III
const cambridge: { classIds: number[]; amounts: FeeAmounts }[] = [
  {
    classIds: [1, 2, 3, 4, 5, 6, 7, 8], // PN → JR-V
    amounts: {
      registration: 19995,
      admission: 59985,
      caution: 39990,
      annual: 19995,
      resource: 19995,
      curricular: 19995,
      monthly: 19995,
    },
  },
  {
    classIds: [9], // SR-I
    amounts: {
      registration: 20995,
      admission: 62985,
      caution: 41990,
      annual: 20995,
      resource: 20995,
      curricular: 20995,
      monthly: 20995,
    },
  },
  {
    classIds: [10], // SR-II
    amounts: {
      registration: 21995,
      admission: 65985,
      caution: 43990,
      annual: 21995,
      resource: 21995,
      curricular: 21995,
      monthly: 21995,
    },
  },
  {
    classIds: [11], // SR-III
    amounts: {
      registration: 22995,
      admission: 68985,
      caution: 45990,
      annual: 22995,
      resource: 22995,
      curricular: 22995,
      monthly: 22995,
    },
  },
  {
    classIds: [12], // O-I
    amounts: {
      registration: 23995,
      admission: 71985,
      caution: 47990,
      annual: 23995,
      resource: 23995,
      curricular: 23995,
      monthly: 23995,
    },
  },
  {
    classIds: [13], // O-II
    amounts: {
      registration: 24995,
      admission: 74985,
      caution: 49990,
      annual: 24995,
      resource: 24995,
      curricular: 24995,
      monthly: 24995,
    },
  },
  {
    classIds: [14], // O-III
    amounts: {
      registration: 25995,
      admission: 77985,
      caution: 51990,
      annual: 25995,
      resource: 25995,
      curricular: 25995,
      monthly: 25995,
    },
  },
];

// Secondary — VI → X
const secondary: { classIds: number[]; amounts: FeeAmounts }[] = [
  {
    classIds: [15], // VI
    amounts: {
      registration: 10575,
      admission: 31725,
      caution: 21150,
      annual: 10575,
      resource: 10575,
      curricular: 10575,
      monthly: 10575,
    },
  },
  {
    classIds: [16], // VII
    amounts: {
      registration: 11575,
      admission: 34725,
      caution: 23150,
      annual: 11575,
      resource: 11575,
      curricular: 11575,
      monthly: 11575,
    },
  },
  {
    classIds: [17], // VIII
    amounts: {
      registration: 12575,
      admission: 37725,
      caution: 25150,
      annual: 12575,
      resource: 12575,
      curricular: 12575,
      monthly: 12575,
    },
  },
  {
    classIds: [18], // IX
    amounts: {
      registration: 13575,
      admission: 40725,
      caution: 27150,
      annual: 13575,
      resource: 13575,
      curricular: 13575,
      monthly: 13575,
    },
  },
  {
    classIds: [19], // X
    amounts: {
      registration: 14575,
      admission: 43725,
      caution: 29150,
      annual: 14575,
      resource: 14575,
      curricular: 14575,
      monthly: 14575,
    },
  },
];

async function main() {
  const existing = await prisma.class_fee_schedule.count({
    where: { campus_id: CAMPUS_ID, academic_year: ACADEMIC_YEAR },
  });
  if (existing > 0) {
    console.log(
      `Found ${existing} existing row(s) for JHR ${ACADEMIC_YEAR} — deleting before insert.`,
    );
    await prisma.class_fee_schedule.deleteMany({
      where: { campus_id: CAMPUS_ID, academic_year: ACADEMIC_YEAR },
    });
  }

  const data = [...cambridge, ...secondary].flatMap(({ classIds, amounts }) =>
    rowsForClasses(classIds, amounts).map((row) => ({
      ...row,
      campus_id: CAMPUS_ID,
      academic_year: ACADEMIC_YEAR,
    })),
  );

  const result = await prisma.class_fee_schedule.createMany({ data });
  console.log(`Inserted ${result.count} row(s) for JHR ${ACADEMIC_YEAR}.`);

  for (const classId of [1, 9, 14, 15, 19]) {
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
