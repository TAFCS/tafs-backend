/**
 * apply-preprimary-allocation-gej-2026.ts
 *
 * Pre-Primary (Johar) class/section + JD + segment from Aug 2026 list.
 *
 * Usage:
 *   npx ts-node scripts/apply-preprimary-allocation-gej-2026.ts
 *   DRY_RUN=false npx ts-node scripts/apply-preprimary-allocation-gej-2026.ts
 */

import { PrismaClient } from '@prisma/client';
import type { ClassSectionAssignment } from './staff-class-section-overrides';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const prisma = new PrismaClient();

const SEG_PRE_PRIMARY = 1;
const PN = 1;
const NUR = 2;
const KG = 3;
const A = 1;
const B = 2;
const C = 3;

function cls(classId: number, sectionIds: number[]): ClassSectionAssignment {
  return { classId, sectionIds: [...sectionIds] };
}

function expandAssignments(rows: ClassSectionAssignment[]) {
  const out: { class_id: number; section_id: number }[] = [];
  for (const row of rows) {
    for (const sectionId of row.sectionIds) {
      out.push({ class_id: row.classId, section_id: sectionId });
    }
  }
  return out;
}

type Row = {
  codeSuffix: string;
  jobTitle: string;
  jobDescription: string;
  assignments: ClassSectionAssignment[];
};

/** Johar Pre-Primary — Aug 2026 */
const ALLOCATIONS: Row[] = [
  {
    codeSuffix: '02-001485',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER PN A',
    assignments: [cls(PN, [A])],
  },
  {
    codeSuffix: '02-001508',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER PN B',
    assignments: [cls(PN, [B])],
  },
  {
    codeSuffix: '02-001511',
    jobTitle: 'ASSISTANT TEACHER',
    jobDescription: 'ASSISTANT TEACHER PN',
    assignments: [cls(PN, [A, B])],
  },
  {
    codeSuffix: '02-001264',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER NUR A',
    assignments: [cls(NUR, [A])],
  },
  {
    codeSuffix: '02-001417',
    jobTitle: 'ASSISTANT TEACHER',
    jobDescription: 'ASSISTANT TEACHER NUR A',
    assignments: [cls(NUR, [A])],
  },
  {
    codeSuffix: '02-001476',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER NUR B',
    assignments: [cls(NUR, [B])],
  },
  {
    codeSuffix: '02-001470',
    jobTitle: 'ASSISTANT TEACHER',
    jobDescription: 'ASSISTANT TEACHER NUR B',
    assignments: [cls(NUR, [B])],
  },
  {
    codeSuffix: '02-001509',
    jobTitle: 'URDU TEACHER',
    jobDescription: 'URDU NUR A–C',
    assignments: [cls(NUR, [A, B, C])],
  },
  {
    codeSuffix: '02-001166',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER KG A',
    assignments: [cls(KG, [A])],
  },
  {
    codeSuffix: '02-001488',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER KG B',
    assignments: [cls(KG, [B])],
  },
  {
    codeSuffix: '02-001404',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER KG C',
    assignments: [cls(KG, [C])],
  },
  {
    codeSuffix: '02-001192',
    jobTitle: 'URDU TEACHER',
    jobDescription: 'URDU KG A–C',
    assignments: [cls(KG, [A, B, C])],
  },
  {
    codeSuffix: '02-0861',
    jobTitle: 'MUSIC TEACHER',
    jobDescription: 'MUSIC PN, NUR & KG',
    assignments: [cls(PN, [A, B]), cls(NUR, [A, B, C]), cls(KG, [A, B, C])],
  },
  {
    codeSuffix: '02-001493',
    jobTitle: 'ART TEACHER',
    jobDescription: 'ART PN, NUR & KG',
    assignments: [cls(PN, [A, B]), cls(NUR, [A, B, C]), cls(KG, [A, B, C])],
  },
];

async function findEmployee(codeSuffix: string) {
  const suffix = codeSuffix.trim().toUpperCase();
  const candidates = await prisma.employee_profiles.findMany({
    where: {
      OR: [
        { employee_code: suffix },
        { employee_code: { endsWith: suffix } },
        { employee_code: { endsWith: `-${suffix}` } },
      ],
    },
    select: { id: true, employee_code: true, full_name: true },
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return (
      candidates.find((c) => c.employee_code?.toUpperCase().endsWith(suffix)) ??
      candidates[0]
    );
  }
  return null;
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===\n' : '=== APPLYING GEJ PRE-PRIMARY ===\n');

  for (const row of ALLOCATIONS) {
    const emp = await findEmployee(row.codeSuffix);
    if (!emp) {
      console.log(`  [MISSING] ${row.codeSuffix}`);
      continue;
    }
    const pairs = expandAssignments(row.assignments);
    console.log(`  [${DRY_RUN ? 'DRY' : 'APPLY'}] ${emp.employee_code} ${emp.full_name} — ${row.jobDescription} (${pairs.length} pairs)`);

    if (DRY_RUN) continue;

    await prisma.employee_profiles.update({
      where: { id: emp.id },
      data: {
        job_title: row.jobTitle,
        job_description: row.jobDescription,
        segment_id: SEG_PRE_PRIMARY,
      },
    });
    await prisma.employee_class_section_assignments.deleteMany({ where: { employee_id: emp.id } });
    if (pairs.length) {
      await prisma.employee_class_section_assignments.createMany({
        data: pairs.map((p) => ({ employee_id: emp.id, ...p })),
      });
    }
  }

  if (DRY_RUN) console.log('\nRun with DRY_RUN=false to apply.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
