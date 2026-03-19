/**
 * Seed script: inserts class_fee_schedule records for all three campuses
 * based on the official TAFS Fee Structure for Academic Session 2025-2026.
 *
 * Fee Type IDs:
 *   1  - MONTHLY TUITION FEE          (MONTHLY)
 *   2  - ADMISSION FEE                (ONE_TIME)
 *   3  - REFUNDABLE/ADJUSTABLE CAUTION FEE (ONE_TIME)  [2 months tuition]
 *   4  - ANNUAL CHARGES               (ONE_TIME)
 *   6  - REGISTRATION/ENROLLMENT FEE  (ONE_TIME)
 *   7  - RESOURCE MATERIAL            (ONE_TIME)
 *   8  - CURRICULAR AND CO-CURRICULAR ACTIVITIES (ONE_TIME)
 *
 * Class IDs (from classes table):
 *   1=PN, 2=NUR, 3=KG,
 *   4=JR-I, 5=JR-II, 6=JR-III, 7=JR-IV, 8=JR-V,
 *   9=SR-I, 10=SR-II, 11=SR-III,
 *   12=O-I, 13=O-II, 14=O-III
 *
 * Campuses:
 *   1 = Gulistan-e-Johar  (JHR)  — full range: PN → O-III
 *   2 = Kaneez Fatima     (KNF)  — PN → JR-V only
 *   3 = North Nazimabad   (NNZ)  — PN → JR-V only
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── Fee type ID constants ─────────────────────────────────────────────────────
const FEE = {
  MONTHLY: 1,
  ADMISSION: 2,
  CAUTION: 3,
  ANNUAL: 4,
  REGISTRATION: 6,
  RESOURCE: 7,
  CURRICULAR: 8,
} as const;

const JOHAR_CAMPUS_ID = 1;
const KNF_CAMPUS_ID   = 2;
const NNZ_CAMPUS_ID   = 3;

// ── Fee schedule data extracted from the official fee structure sheet ─────────
// Format: [class_id, fee_type_id, amount]
// Johar has the full range (PN → O-III); KNF & NNZ share PN → JR-V fees.
const feeData: [number, number, number][] = [
  // ── PRE-NURSERY (class_id = 1) ──────────────────────────────────────────────
  [1, FEE.REGISTRATION, 18575],
  [1, FEE.ADMISSION,    55725],
  [1, FEE.CAUTION,      37150],
  [1, FEE.ANNUAL,       18575],
  [1, FEE.RESOURCE,     18575],
  [1, FEE.CURRICULAR,   18575],
  [1, FEE.MONTHLY,      18575],

  // ── NURSERY (class_id = 2) ──────────────────────────────────────────────────
  [2, FEE.REGISTRATION, 18575],
  [2, FEE.ADMISSION,    55725],
  [2, FEE.CAUTION,      37150],
  [2, FEE.ANNUAL,       18575],
  [2, FEE.RESOURCE,     18575],
  [2, FEE.CURRICULAR,   18575],
  [2, FEE.MONTHLY,      18575],

  // ── K.G. (class_id = 3) ─────────────────────────────────────────────────────
  [3, FEE.REGISTRATION, 18575],
  [3, FEE.ADMISSION,    55725],
  [3, FEE.CAUTION,      37150],
  [3, FEE.ANNUAL,       18575],
  [3, FEE.RESOURCE,     18575],
  [3, FEE.CURRICULAR,   18575],
  [3, FEE.MONTHLY,      18575],

  // ── JR-I (class_id = 4) ─────────────────────────────────────────────────────
  [4, FEE.REGISTRATION, 18575],
  [4, FEE.ADMISSION,    55725],
  [4, FEE.CAUTION,      37150],
  [4, FEE.ANNUAL,       18575],
  [4, FEE.RESOURCE,     18575],
  [4, FEE.CURRICULAR,   18575],
  [4, FEE.MONTHLY,      18575],

  // ── JR-II (class_id = 5) ────────────────────────────────────────────────────
  [5, FEE.REGISTRATION, 18575],
  [5, FEE.ADMISSION,    55725],
  [5, FEE.CAUTION,      37150],
  [5, FEE.ANNUAL,       18575],
  [5, FEE.RESOURCE,     18575],
  [5, FEE.CURRICULAR,   18575],
  [5, FEE.MONTHLY,      18575],

  // ── JR-III (class_id = 6) ───────────────────────────────────────────────────
  [6, FEE.REGISTRATION, 18575],
  [6, FEE.ADMISSION,    55725],
  [6, FEE.CAUTION,      37150],
  [6, FEE.ANNUAL,       18575],
  [6, FEE.RESOURCE,     18575],
  [6, FEE.CURRICULAR,   18575],
  [6, FEE.MONTHLY,      18575],

  // ── JR-IV (class_id = 7) ────────────────────────────────────────────────────
  [7, FEE.REGISTRATION, 18575],
  [7, FEE.ADMISSION,    55725],
  [7, FEE.CAUTION,      37150],
  [7, FEE.ANNUAL,       18575],
  [7, FEE.RESOURCE,     18575],
  [7, FEE.CURRICULAR,   18575],
  [7, FEE.MONTHLY,      18575],

  // ── JR-V (class_id = 8) ─────────────────────────────────────────────────────
  [8, FEE.REGISTRATION, 18575],
  [8, FEE.ADMISSION,    55725],
  [8, FEE.CAUTION,      37150],
  [8, FEE.ANNUAL,       18575],
  [8, FEE.RESOURCE,     18575],
  [8, FEE.CURRICULAR,   18575],
  [8, FEE.MONTHLY,      18575],

  // ── SR-I (class_id = 9) ─────────────────────────────────────────────────────
  [9, FEE.REGISTRATION, 19575],
  [9, FEE.ADMISSION,    58725],
  [9, FEE.CAUTION,      39150],
  [9, FEE.ANNUAL,       18575],
  [9, FEE.RESOURCE,     19575],
  [9, FEE.CURRICULAR,   19575],
  [9, FEE.MONTHLY,      19575],

  // ── SR-II (class_id = 10) ───────────────────────────────────────────────────
  [10, FEE.REGISTRATION, 20575],
  [10, FEE.ADMISSION,    61725],
  [10, FEE.CAUTION,      41150],
  [10, FEE.ANNUAL,       20575],
  [10, FEE.RESOURCE,     20575],
  [10, FEE.CURRICULAR,   20575],
  [10, FEE.MONTHLY,      20575],

  // ── SR-III (class_id = 11) ──────────────────────────────────────────────────
  [11, FEE.REGISTRATION, 21575],
  [11, FEE.ADMISSION,    64725],
  [11, FEE.CAUTION,      43150],
  [11, FEE.ANNUAL,       21575],
  [11, FEE.RESOURCE,     21575],
  [11, FEE.CURRICULAR,   21575],
  [11, FEE.MONTHLY,      21575],

  // ── O-I (class_id = 12) ─────────────────────────────────────────────────────
  [12, FEE.REGISTRATION, 22575],
  [12, FEE.ADMISSION,    67725],
  [12, FEE.CAUTION,      45150],
  [12, FEE.ANNUAL,       22575],
  [12, FEE.RESOURCE,     22575],
  [12, FEE.CURRICULAR,   22575],
  [12, FEE.MONTHLY,      22575],

  // ── O-II (class_id = 13) ────────────────────────────────────────────────────
  [13, FEE.REGISTRATION, 23575],
  [13, FEE.ADMISSION,    70725],
  [13, FEE.CAUTION,      47150],
  [13, FEE.ANNUAL,       23575],
  [13, FEE.RESOURCE,     23575],
  [13, FEE.CURRICULAR,   23575],
  [13, FEE.MONTHLY,      23575],

  // ── O-III (class_id = 14) ───────────────────────────────────────────────────
  [14, FEE.REGISTRATION, 24575],
  [14, FEE.ADMISSION,    73725],
  [14, FEE.CAUTION,      49150],
  [14, FEE.ANNUAL,       24575],
  [14, FEE.RESOURCE,     24575],
  [14, FEE.CURRICULAR,   24575],
  [14, FEE.MONTHLY,      24575],
];

// ── Class ranges ──────────────────────────────────────────────────────────────
// PN=1 … JR-V=8  (shared by all campuses)
const PN_TO_JRV_CLASS_IDS = [1, 2, 3, 4, 5, 6, 7, 8];

async function seedCampus(
  campusId: number,
  campusLabel: string,
  allowedClassIds: number[],
) {
  const rows = feeData.filter(([classId]) => allowedClassIds.includes(classId));

  const deleted = await prisma.class_fee_schedule.deleteMany({
    where: { campus_id: campusId },
  });
  console.log(`🗑️   [${campusLabel}] Cleared ${deleted.count} existing row(s).`);

  const result = await prisma.class_fee_schedule.createMany({
    data: rows.map(([class_id, fee_id, amount]) => ({
      class_id,
      fee_id,
      amount,
      campus_id: campusId,
    })),
    skipDuplicates: true,
  });
  console.log(`✅  [${campusLabel}] Inserted ${result.count} fee schedule row(s).`);
}

async function main() {
  console.log('🌱  Seeding class_fee_schedule for all campuses...\n');

  // Campus 1 — Johar: full range PN → O-III
  const allClassIds = feeData.map(([cid]) => cid).filter((v, i, a) => a.indexOf(v) === i);
  await seedCampus(JOHAR_CAMPUS_ID, 'Johar (JHR)', allClassIds);

  // Campus 2 — Kaneez Fatima: PN → JR-V only
  await seedCampus(KNF_CAMPUS_ID, 'Kaneez Fatima (KNF)', PN_TO_JRV_CLASS_IDS);

  // Campus 3 — North Nazimabad: PN → JR-V only
  await seedCampus(NNZ_CAMPUS_ID, 'North Nazimabad (NNZ)', PN_TO_JRV_CLASS_IDS);

  console.log('\n📋  Fee schedule summary (PN → JR-V, all campuses share same amounts):');
  const classes: [number, string][] = [
    [1, 'Pre-Nursery'], [2, 'Nursery'], [3, 'K.G.'],
    [4, 'JR-I'],        [5, 'JR-II'],  [6, 'JR-III'],
    [7, 'JR-IV'],       [8, 'JR-V'],
  ];
  console.log('─'.repeat(65));
  console.log(
    'Class'.padEnd(12),
    'Reg'.padStart(7),
    'Adm'.padStart(7),
    'Caut'.padStart(7),
    'Annual'.padStart(7),
    'Res'.padStart(7),
    'Curr'.padStart(7),
    'Monthly'.padStart(8),
  );
  console.log('─'.repeat(65));
  for (const [classId, className] of classes) {
    const row = feeData.filter(([cid]) => cid === classId);
    const get = (feeId: number) =>
      (row.find(([, fid]) => fid === feeId)?.[2] ?? 0).toLocaleString();
    console.log(
      String(className).padEnd(12),
      get(FEE.REGISTRATION).padStart(7),
      get(FEE.ADMISSION).padStart(7),
      get(FEE.CAUTION).padStart(7),
      get(FEE.ANNUAL).padStart(7),
      get(FEE.RESOURCE).padStart(7),
      get(FEE.CURRICULAR).padStart(7),
      get(FEE.MONTHLY).padStart(8),
    );
  }
  console.log('─'.repeat(65));
}

main()
  .catch((e) => {
    console.error('❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
