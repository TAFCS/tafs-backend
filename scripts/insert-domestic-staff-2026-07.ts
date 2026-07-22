/**
 * insert-domestic-staff-2026-07.ts
 *
 * One-off insert for 8 previously-unmapped ZK device PINs that turned out to be
 * domestic/support staff present in the July 2026 HR intake sheet but missing
 * from employee_profiles. See TAFS_HR_Employee_Intake.xlsx ("1 - Employee Data").
 *
 * These employees have no Attendance & Pay sheet row, so reporting_time,
 * leaving_time, late_relaxation_minutes, monthly_pay, campus_id, and
 * days_per_week are left null pending HR follow-up.
 *
 * Requires migration 20260713120000_add_support_staff_category to have been
 * applied first (adds StaffCategory.SUPPORT_STAFF).
 *
 * DRY_RUN=true by default. Set DRY_RUN=false to actually commit.
 *
 * Usage:
 *   npx ts-node scripts/insert-domestic-staff-2026-07.ts
 *   DRY_RUN=false npx ts-node scripts/insert-domestic-staff-2026-07.ts
 */

import { PrismaClient } from '@prisma/client';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const prisma = new PrismaClient();

interface NewEmployee {
  employee_code: string;
  full_name: string;
  father_name: string | null;
  mother_name: string | null;
  cnic: string | null;
  date_of_birth: string | null; // YYYY-MM-DD
  join_date: string; // YYYY-MM-DD
  address: string | null;
  personal_phone: string | null;
  designationTitle: 'PEON' | 'CARE TAKER';
}

const NEW_EMPLOYEES: NewEmployee[] = [
  {
    employee_code: '04-005081',
    full_name: 'NUSTRAT RAHAT',
    father_name: 'VICTOR',
    mother_name: 'HAMEEDA',
    cnic: '42201-4189737-0',
    date_of_birth: '1985-08-07',
    join_date: '2026-05-26',
    address: 'HOUSE # B-153, SECTOR # 30, BHITAIYABAD, G-E-J, KARACHI',
    personal_phone: '0327-8451811',
    designationTitle: 'PEON',
  },
  {
    employee_code: '04-005052',
    full_name: 'HIDAYATULLAH',
    father_name: 'REHMAT ULLAH',
    mother_name: 'MAI HIDAYAT',
    cnic: '45202-7941560-9',
    date_of_birth: '2003-07-07',
    join_date: '2026-06-02',
    address: 'BLOCK # 09, RASHEDI GOTH, GULSHAN-E-IQBAL',
    personal_phone: '0305-2498629',
    designationTitle: 'PEON',
  },
  {
    employee_code: '04-00143',
    full_name: 'SHAFIQUE HUSSAIN',
    father_name: 'NAZIR AHMED KHAN',
    mother_name: null,
    cnic: '31303-2452231-5',
    date_of_birth: null,
    join_date: '2011-09-29',
    address:
      'HUSSAIN HAZARA GOTH MODEL YELEG NEAR METRO SHOPPING CENTRE B-11, L-61 GULSHAN-E-IQBAL',
    personal_phone: '0305-3376459',
    designationTitle: 'CARE TAKER',
  },
  {
    employee_code: '04-00151',
    full_name: 'SAQLAIN ABBAS',
    father_name: 'WAZIR HUSSAIN',
    mother_name: null,
    cnic: '31303-2442897-7',
    date_of_birth: null,
    join_date: '2011-10-06',
    address:
      'HOUSE# L-131, BLOCK-11, HUSSAIN HAZARA GOTH METRO SHOPPING CENTRE GULSHAN-E-IQBAL, KARACHI',
    personal_phone: '0303-2568080',
    designationTitle: 'CARE TAKER',
  },
  {
    employee_code: '04-0050115',
    full_name: 'TAJ MUHAMMAD',
    father_name: 'EID O HASAN',
    mother_name: 'NOOR BAI',
    cnic: '42501-0665674-3',
    date_of_birth: '2001-01-01',
    join_date: '2026-06-03',
    address: 'BLOCK # 09, RASHEDI GOTH, GULSHAN-E-IQBAL',
    personal_phone: '0337-3473292',
    designationTitle: 'PEON',
  },
  {
    employee_code: '04-0050110',
    full_name: 'HASSAN RAZA',
    father_name: 'SABZAL',
    mother_name: 'KANEEZ BIBI',
    cnic: '31303-3229120-3',
    date_of_birth: '2003-01-07',
    join_date: '2026-03-24',
    address: 'BLOCK # 11, HAZARAGOTH, GULSHAN-E-IQBAL',
    personal_phone: '0318-176142',
    designationTitle: 'PEON',
  },
  {
    employee_code: '04-0050116',
    full_name: 'MUHAMMAD ARIF',
    father_name: 'MUHAMMAD KALU',
    mother_name: 'MAQSOOD BIBI',
    cnic: '31301-9850550-1',
    date_of_birth: '1998-01-01',
    join_date: '2026-01-06',
    address: 'C-155, KALANDARBAD, BLOCK # 10, GULSHAN-E-JOHAR',
    personal_phone: '0306-2703235',
    designationTitle: 'CARE TAKER',
  },
  {
    employee_code: '04-0050113',
    full_name: 'ZEESHAN ABBAS',
    father_name: 'GHULAM ABBAS',
    mother_name: 'SUFAI MAI',
    cnic: '31303-2752937-3',
    date_of_birth: '1997-01-07',
    join_date: '2026-04-27',
    address: 'BLOCK # 11, HAZARAGOTH, GULSHAN-E-IQBAL',
    personal_phone: '0370-3589496',
    designationTitle: 'PEON',
  },
];

const DESIGNATIONS = ['PEON', 'CARE TAKER'] as const;
const STAFF_TYPES: { code: string; name: string }[] = [
  { code: 'peon', name: 'PEON' },
  { code: 'care_taker', name: 'CARE TAKER' },
];

async function ensureDesignation(title: string): Promise<number> {
  const existing = await prisma.designations.findFirst({ where: { title } });
  if (existing) return existing.id;
  const created = await prisma.designations.create({ data: { title, department_id: null } });
  return created.id;
}

async function ensureStaffType(code: string, name: string): Promise<number> {
  const existing = await prisma.staff_types.findUnique({ where: { code } });
  if (existing) return existing.id;
  const created = await prisma.staff_types.create({ data: { code, name, is_active: true } });
  return created.id;
}

async function main() {
  console.log(`Employees to insert: ${NEW_EMPLOYEES.length}`);
  console.log(`Designations to ensure: ${DESIGNATIONS.join(', ')}`);
  console.log(`Staff types to ensure: ${STAFF_TYPES.map((s) => s.code).join(', ')}`);

  for (const e of NEW_EMPLOYEES) {
    const existing = await prisma.employee_profiles.findFirst({
      where: { employee_code: e.employee_code },
    });
    if (existing) {
      console.log(`  SKIP ${e.employee_code} (${e.full_name}) — already exists as id ${existing.id}`);
    } else {
      console.log(`  WILL INSERT ${e.employee_code} — ${e.full_name} (${e.designationTitle})`);
    }
  }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: no changes written. Set DRY_RUN=false to commit. ---');
    await prisma.$disconnect();
    return;
  }

  const designationIdByTitle = new Map<string, number>();
  for (const title of DESIGNATIONS) {
    designationIdByTitle.set(title, await ensureDesignation(title));
  }

  const staffTypeIdByCode = new Map<string, number>();
  for (const st of STAFF_TYPES) {
    staffTypeIdByCode.set(st.code, await ensureStaffType(st.code, st.name));
  }
  const staffTypeCodeByTitle: Record<string, string> = { PEON: 'peon', 'CARE TAKER': 'care_taker' };

  const supportServicesDept = await prisma.departments.findFirst({
    where: { name: 'SUPPORT SERVICES' },
  });
  const supportStaffCategory = await prisma.staff_categories.findFirst({
    where: { code: 'SUPPORT_STAFF' },
  });
  const supportServicesDeptId = supportServicesDept?.id ?? null;
  const supportStaffCategoryId = supportStaffCategory?.id ?? null;

  let created = 0;
  let skipped = 0;

  for (const e of NEW_EMPLOYEES) {
    const existing = await prisma.employee_profiles.findFirst({
      where: { employee_code: e.employee_code },
    });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.employee_profiles.create({
      data: {
        employee_code: e.employee_code,
        full_name: e.full_name,
        father_name: e.father_name,
        mother_name: e.mother_name,
        cnic: e.cnic,
        date_of_birth: e.date_of_birth ? new Date(`${e.date_of_birth}T00:00:00Z`) : null,
        join_date: new Date(`${e.join_date}T00:00:00Z`),
        address: e.address,
        personal_phone: e.personal_phone,
        designation_id: designationIdByTitle.get(e.designationTitle) ?? null,
        staff_type_id: staffTypeIdByCode.get(staffTypeCodeByTitle[e.designationTitle]) ?? null,
        staff_category_id: supportStaffCategoryId,
        department_id: supportServicesDeptId,
        reporting_time: null,
        leaving_time: null,
        late_relaxation_minutes: null,
        monthly_pay: null,
        campus_id: null,
        days_per_week: null,
      },
    });
    created++;
  }

  console.log(`\nCreated: ${created}, Skipped (already existed): ${skipped}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
