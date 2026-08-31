/**
 * apply-teacher-allocation-2026.ts
 *
 * Bulk-create missing teachers and apply class/section assignments, segment_id,
 * job_title, and job_description from the Aug 2026 allocation lists.
 *
 * Usage:
 *   npx ts-node scripts/apply-teacher-allocation-2026.ts
 *   DRY_RUN=false npx ts-node scripts/apply-teacher-allocation-2026.ts
 */

import { PrismaClient } from '@prisma/client';
import {
  campusPrefixForId,
  composeEmployeeCode,
  parseEmployeeCode,
} from '../src/modules/hr/employees/employee-code.util';
import type { ClassSectionAssignment } from './staff-class-section-overrides';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const prisma = new PrismaClient();

const SEG = {
  PRE_PRIMARY: 1,
  JUNIOR: 2,
  SENIOR: 3,
  OLEVEL: 4,
  SECONDARY: 6,
} as const;

const CAMPUS = { GEJ: 1, GKF: 2, NNN: 3 } as const;

const ABC = [1, 2, 3] as const;
const ABCD = [1, 2, 3, 4] as const;

type StaffCategoryCode = 'TEACHER' | 'ASSISTANT_TEACHER' | 'SPORTS_COACH' | 'SCOUT_LEADER';

interface AllocationRow {
  codeSuffix?: string;
  create?: {
    fullName: string;
    campusId: number;
    dep?: string;
    codeNumber: string;
    staffCategory?: StaffCategoryCode;
  };
  jobTitle: string;
  jobDescription: string;
  segmentId?: number | null;
  assignments: ClassSectionAssignment[];
  skip?: boolean;
  skipReason?: string;
}

function cls(classId: number, sectionIds: readonly number[]): ClassSectionAssignment {
  return { classId, sectionIds: [...sectionIds] };
}

function allSections(classIds: readonly number[], sections: readonly number[] = ABCD): ClassSectionAssignment[] {
  return classIds.map((classId) => ({ classId, sectionIds: [...sections] }));
}

function mergeAssignments(rows: ClassSectionAssignment[]): ClassSectionAssignment[] {
  const byClass = new Map<number, Set<number>>();
  for (const row of rows) {
    const set = byClass.get(row.classId) ?? new Set<number>();
    for (const s of row.sectionIds) set.add(s);
    byClass.set(row.classId, set);
  }
  return [...byClass.entries()]
    .sort(([a], [b]) => a - b)
    .map(([classId, sectionIds]) => ({
      classId,
      sectionIds: [...sectionIds].sort((a, b) => a - b),
    }));
}

function expandAssignments(rows: ClassSectionAssignment[]): { class_id: number; section_id: number }[] {
  const out: { class_id: number; section_id: number }[] = [];
  for (const row of rows) {
    for (const sectionId of row.sectionIds) {
      out.push({ class_id: row.classId, section_id: sectionId });
    }
  }
  return out;
}

function overrideKey(employeeCode: string): string {
  const parsed = parseEmployeeCode(employeeCode);
  if (parsed) return `${parsed.dep}-${parsed.number}`;
  return employeeCode.trim().toUpperCase();
}

const ALLOCATIONS: AllocationRow[] = [
  // Secondary (Johar)
  {
    codeSuffix: '02-00644',
    jobTitle: 'URDU & SINDHI TEACHER',
    jobDescription: 'URDU (VI–VII), SINDHI (VI–VIII & X)',
    segmentId: SEG.SECONDARY,
    assignments: mergeAssignments([...allSections([15, 16], ABC), ...allSections([17, 19], ABC)]),
  },
  {
    codeSuffix: '02-001138',
    jobTitle: 'SCIENCE & SOCIAL STUDIES TEACHER',
    jobDescription: 'SCIENCE (VI–VIII), S.S.T (VII), P.S.T (VIII & X)',
    segmentId: SEG.SECONDARY,
    assignments: mergeAssignments([...allSections([15, 16, 17], ABC), cls(19, ABC)]),
  },
  {
    codeSuffix: '02-001359',
    jobTitle: 'COMPUTER SCIENCE TEACHER',
    jobDescription: 'COMPUTER (VI–X)',
    segmentId: SEG.SECONDARY,
    assignments: allSections([15, 16, 17, 18, 19], ABC),
  },
  {
    codeSuffix: '02-001487',
    jobTitle: 'MATHEMATICS TEACHER',
    jobDescription: 'MATHS (VI–X)',
    segmentId: SEG.SECONDARY,
    assignments: allSections([15, 16, 17, 18, 19], ABC),
  },
  {
    codeSuffix: '02-001506',
    jobTitle: 'ENGLISH TEACHER',
    jobDescription: 'ENGLISH (VI–X)',
    segmentId: SEG.SECONDARY,
    assignments: allSections([15, 16, 17, 18, 19], ABC),
  },
  {
    codeSuffix: '02-001388',
    jobTitle: 'BIOLOGY, CHEMISTRY & PHYSICS TEACHER',
    jobDescription: 'BIOLOGY (IX–X), CHEMISTRY (IX–X), PHYSICS (IX–X)',
    segmentId: SEG.SECONDARY,
    assignments: allSections([18, 19], ABC),
  },
  {
    codeSuffix: '02-001339',
    jobTitle: 'ISLAMIYAT TEACHER',
    jobDescription: 'ISLAMIAT (VI–IX)',
    segmentId: SEG.SECONDARY,
    assignments: allSections([15, 16, 17, 18], ABC),
  },
  {
    codeSuffix: '05-00031',
    jobTitle: 'GYMNASTICS & BAND COACH',
    jobDescription: 'GYM & BAND (VIII–IX)',
    segmentId: SEG.SECONDARY,
    assignments: allSections([17, 18], ABC),
  },
  {
    codeSuffix: '02-001503',
    jobTitle: 'URDU TEACHER',
    jobDescription: 'URDU SR. I; SECONDARY VII–VIII',
    segmentId: null,
    assignments: mergeAssignments([...allSections([9], ABC), ...allSections([16, 17], ABC)]),
  },

  // Juniors — Jr I & II
  {
    codeSuffix: '02-001405',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER JR. I A',
    segmentId: SEG.JUNIOR,
    assignments: [cls(4, [1])],
  },
  {
    codeSuffix: '02-001491',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER JR. I B',
    segmentId: SEG.JUNIOR,
    assignments: [cls(4, [2])],
  },
  {
    codeSuffix: '02-001439',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER JR. I C',
    segmentId: SEG.JUNIOR,
    assignments: [cls(4, [3])],
  },
  {
    codeSuffix: '02-001497',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER JR. I D',
    segmentId: SEG.JUNIOR,
    assignments: [cls(4, [4])],
  },
  {
    codeSuffix: '02-001496',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER JR. II A',
    segmentId: SEG.JUNIOR,
    assignments: [cls(5, [1])],
  },
  {
    codeSuffix: '02-001512',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER JR. II D',
    segmentId: SEG.JUNIOR,
    assignments: [cls(5, [4])],
  },
  {
    codeSuffix: '02-001414',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER JR. II B',
    segmentId: SEG.JUNIOR,
    assignments: [cls(5, [2])],
  },
  {
    codeSuffix: '02-001406',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'HOME TEACHER JR. II C',
    segmentId: SEG.JUNIOR,
    assignments: [cls(5, [3])],
  },
  {
    codeSuffix: '02-001197',
    jobTitle: 'URDU TEACHER',
    jobDescription: 'URDU TEACHER JR. I',
    segmentId: SEG.JUNIOR,
    assignments: [cls(4, ABCD)],
  },
  {
    codeSuffix: '02-001355',
    jobTitle: 'URDU TEACHER',
    jobDescription: 'URDU TEACHER JR. II',
    segmentId: SEG.JUNIOR,
    assignments: [cls(5, ABCD)],
  },
  {
    codeSuffix: '02-001486',
    jobTitle: 'COMPUTER SCIENCE TEACHER',
    jobDescription: 'COMPUTER TEACHER JR. I & II',
    segmentId: SEG.JUNIOR,
    assignments: allSections([4, 5], ABCD),
  },

  // Juniors — Jr III–V + PDF
  {
    codeSuffix: '02-001424',
    jobTitle: 'ENGLISH TEACHER',
    jobDescription: 'ENGLISH JUNIOR III',
    segmentId: SEG.JUNIOR,
    assignments: [cls(6, ABCD)],
  },
  {
    codeSuffix: '02-001352',
    jobTitle: 'ENGLISH TEACHER',
    jobDescription: 'ENGLISH JUNIOR IV; ISLAMIYAT JUNIOR V B',
    segmentId: SEG.JUNIOR,
    assignments: mergeAssignments([cls(7, ABCD), cls(8, [2])]),
  },
  {
    codeSuffix: '02-001420',
    jobTitle: 'ENGLISH TEACHER',
    jobDescription: 'ENGLISH JUNIOR V',
    segmentId: SEG.JUNIOR,
    assignments: [cls(8, ABCD)],
  },
  {
    codeSuffix: '02-001248',
    jobTitle: 'SCIENCE TEACHER',
    jobDescription: 'SCIENCE JUNIOR III–V',
    segmentId: SEG.JUNIOR,
    assignments: allSections([6, 7, 8], ABCD),
  },
  {
    codeSuffix: '02-001219',
    jobTitle: 'URDU TEACHER',
    jobDescription: 'URDU GRAMMAR, LITERATURE & CREATIVE COMPREHENSION JUNIOR III',
    segmentId: SEG.JUNIOR,
    assignments: [cls(6, ABCD)],
  },
  {
    codeSuffix: '02-001383',
    jobTitle: 'URDU TEACHER',
    jobDescription: 'URDU JUNIOR IV',
    segmentId: SEG.JUNIOR,
    assignments: [cls(7, ABCD)],
  },
  {
    codeSuffix: '02-001407',
    jobTitle: 'URDU TEACHER',
    jobDescription: 'URDU JUNIOR V',
    segmentId: SEG.JUNIOR,
    assignments: [cls(8, ABCD)],
  },
  {
    codeSuffix: '02-001365',
    jobTitle: 'ART TEACHER',
    jobDescription: 'ARTS JUNIOR I–V',
    segmentId: SEG.JUNIOR,
    assignments: allSections([4, 5, 6, 7, 8], ABCD),
  },
  {
    codeSuffix: '02-001337',
    jobTitle: 'COMPUTER SCIENCE TEACHER',
    jobDescription: 'COMPUTER JUNIOR I–IV',
    segmentId: SEG.JUNIOR,
    assignments: allSections([4, 5, 6, 7], ABCD),
  },
  {
    create: { fullName: 'AMARA', campusId: CAMPUS.GEJ, codeNumber: '001514' },
    jobTitle: 'MATHEMATICS & COMPUTER TEACHER',
    jobDescription: 'MATHS JUNIOR III A–C & JUNIOR IV C; COMPUTER JUNIOR V A–C',
    segmentId: SEG.JUNIOR,
    assignments: mergeAssignments([cls(6, [1, 2, 3]), cls(7, [3]), cls(8, ABC)]),
  },
  {
    create: { fullName: 'MINAAHIL', campusId: CAMPUS.GEJ, codeNumber: '001515' },
    jobTitle: 'MATHEMATICS TEACHER',
    jobDescription: 'MATHS JUNIOR IV A & B; JUNIOR V A–C',
    segmentId: SEG.JUNIOR,
    assignments: mergeAssignments([cls(7, [1, 2]), cls(8, ABC)]),
  },
  {
    create: { fullName: 'AKSA', campusId: CAMPUS.GEJ, codeNumber: '001516' },
    jobTitle: 'ENGLISH LITERATURE TEACHER',
    jobDescription: 'ENGLISH LITERATURE JUNIOR III–V; ISLAMIYAT JUNIOR IV A–C',
    segmentId: SEG.JUNIOR,
    assignments: allSections([6, 7, 8], ABCD),
  },
  {
    codeSuffix: '02-001500',
    jobTitle: 'SOCIAL STUDIES TEACHER',
    jobDescription: 'S.S.T JUNIOR III–V; ISLAMIYAT JUNIOR III A–C',
    segmentId: SEG.JUNIOR,
    assignments: allSections([6, 7, 8], ABCD),
  },
  {
    create: {
      fullName: 'ANNA MAKRAM',
      campusId: CAMPUS.GEJ,
      codeNumber: '001517',
      staffCategory: 'SPORTS_COACH',
    },
    jobTitle: 'SPORTS TEACHER',
    jobDescription: 'SPORTS JUNIOR I–V',
    segmentId: SEG.JUNIOR,
    assignments: allSections([4, 5, 6, 7, 8], ABCD),
  },
  {
    create: { fullName: 'SHARIQ', campusId: CAMPUS.GEJ, codeNumber: '001518' },
    jobTitle: 'ROBOTICS TEACHER',
    jobDescription: 'ROBOTICS',
    segmentId: SEG.JUNIOR,
    assignments: [],
  },
  {
    codeSuffix: '02-001507',
    jobTitle: 'TAEKWONDO COACH',
    jobDescription: 'TAEKWONDO JUNIOR I–V',
    segmentId: SEG.JUNIOR,
    assignments: allSections([4, 5, 6, 7, 8], ABCD),
  },
  {
    codeSuffix: '02-001375',
    jobTitle: 'SCOUT LEADER',
    jobDescription: 'SCOUTS JUNIOR I–V',
    segmentId: SEG.JUNIOR,
    assignments: allSections([4, 5, 6, 7, 8], ABCD),
  },
  {
    codeSuffix: '02-001376',
    jobTitle: 'SCOUT LEADER',
    jobDescription: 'SCOUTS JUNIOR I–V',
    segmentId: SEG.JUNIOR,
    assignments: allSections([4, 5, 6, 7, 8], ABCD),
  },

  // Seniors (Johar)
  {
    codeSuffix: '02-001505',
    jobTitle: 'ENGLISH TEACHER',
    jobDescription: 'ENGLISH SR. I–II',
    segmentId: SEG.SENIOR,
    assignments: allSections([9, 10], ABC),
  },
  {
    codeSuffix: '02-001338',
    jobTitle: 'ENGLISH TEACHER',
    jobDescription: 'ENGLISH SR. III–O-II',
    segmentId: null,
    assignments: allSections([11, 12, 13], ABC),
  },
  {
    codeSuffix: '02-0593',
    jobTitle: 'URDU TEACHER',
    jobDescription: 'URDU SR. II, SR. III; ONE BLOCK O-I & O-II',
    segmentId: null,
    assignments: [cls(10, [1, 3]), cls(11, ABC)],
  },
  {
    codeSuffix: '02-001427',
    jobTitle: 'MATHEMATICS TEACHER',
    jobDescription: 'MATHS SR. I & II',
    segmentId: SEG.SENIOR,
    assignments: allSections([9, 10], ABC),
  },
  {
    codeSuffix: '02-0635',
    jobTitle: 'MATHEMATICS TEACHER',
    jobDescription: 'MATHS SR. III–O-II',
    segmentId: null,
    assignments: allSections([11, 12, 13], ABC),
  },
  {
    codeSuffix: '02-001348',
    jobTitle: 'BIOLOGY TEACHER',
    jobDescription: 'BIOLOGY SR. I–III; ISLAMIYAT SR. IB & IC',
    segmentId: null,
    assignments: allSections([9, 10, 11, 12, 13], ABC),
  },
  {
    codeSuffix: '02-001502',
    jobTitle: 'CHEMISTRY TEACHER',
    jobDescription: 'CHEMISTRY SR. I–III; ISLAMIYAT SR. IA',
    segmentId: SEG.SENIOR,
    assignments: allSections([9, 10, 11], ABC),
  },
  {
    codeSuffix: '02-001475',
    jobTitle: 'PHYSICS TEACHER',
    jobDescription: 'PHYSICS SR. I–III',
    segmentId: SEG.SENIOR,
    assignments: allSections([9, 10, 11], ABC),
  },
  {
    codeSuffix: '02-001271',
    jobTitle: 'HISTORY, GEOGRAPHY & ISLAMIYAT TEACHER',
    jobDescription: 'HISTORY SR. IA; HISTORY + GEOGRAPHY SR. II; ISLAMIYAT SR. II & III',
    segmentId: SEG.SENIOR,
    assignments: allSections([9, 10, 11], ABC),
  },
  {
    codeSuffix: '02-001435',
    jobTitle: 'HISTORY & GEOGRAPHY TEACHER',
    jobDescription: 'HISTORY SR. IB & IC; GEOGRAPHY SR. I; HISTORY + GEOGRAPHY SR. III',
    segmentId: SEG.SENIOR,
    assignments: allSections([9, 11], ABC),
  },
  {
    codeSuffix: '02-001494',
    jobTitle: 'COMPUTER SCIENCE TEACHER',
    jobDescription: 'COMPUTER SR. I–O-II',
    segmentId: null,
    assignments: allSections([9, 10, 11, 12, 13], ABC),
  },

  // GKF
  {
    codeSuffix: '02-00019',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'PRE-NURSERY LEAD TEACHER',
    segmentId: SEG.PRE_PRIMARY,
    assignments: [cls(1, ABC)],
  },
  {
    create: { fullName: 'BARIRA', campusId: CAMPUS.GKF, codeNumber: '00021', staffCategory: 'ASSISTANT_TEACHER' },
    jobTitle: 'ASSISTANT TEACHER',
    jobDescription: 'PRE-NURSERY ASSISTANT TEACHER',
    segmentId: SEG.PRE_PRIMARY,
    assignments: [cls(1, ABC)],
  },
  {
    codeSuffix: '02-00020',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'NURSERY A',
    segmentId: SEG.PRE_PRIMARY,
    assignments: [cls(2, [1])],
  },
  {
    codeSuffix: '02-00025',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'NURSERY B LEAD TEACHER',
    segmentId: SEG.PRE_PRIMARY,
    assignments: [cls(2, [2])],
  },
  {
    codeSuffix: '02-00010',
    jobTitle: 'CO-TEACHER',
    jobDescription: 'NURSERY B ASSISTANT TEACHER',
    segmentId: SEG.PRE_PRIMARY,
    assignments: [cls(2, [2])],
  },
  {
    codeSuffix: '02-00011',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'KG',
    segmentId: SEG.PRE_PRIMARY,
    assignments: [cls(3, ABC)],
  },
  {
    codeSuffix: '02-00023',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'JUNIOR I',
    segmentId: SEG.JUNIOR,
    assignments: [cls(4, ABC)],
  },
  {
    codeSuffix: '02-00027',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'JUNIOR II',
    segmentId: SEG.JUNIOR,
    assignments: [cls(5, ABC)],
  },
  {
    codeSuffix: '02-00018',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'JUNIOR III CLASS TEACHER; ENGLISH (III & IV)',
    segmentId: SEG.JUNIOR,
    assignments: allSections([6, 7], ABC),
  },
  {
    codeSuffix: '02-00015',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'JUNIOR IV CLASS TEACHER; SOCIAL STUDIES, SCIENCE & COMPUTER (III & IV)',
    segmentId: SEG.JUNIOR,
    assignments: allSections([6, 7, 8], ABC),
  },
  {
    codeSuffix: '02-00028',
    jobTitle: 'URDU TEACHER',
    jobDescription: 'URDU JUNIOR I, II, III & IV',
    segmentId: SEG.JUNIOR,
    assignments: allSections([4, 5, 6, 7], ABC),
  },

  // North Nazimabad
  {
    codeSuffix: '02-0067',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'PRE-NURSERY & NURSERY',
    segmentId: SEG.PRE_PRIMARY,
    assignments: allSections([1, 2], ABC),
  },
  {
    codeSuffix: '02-0071',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'KG',
    segmentId: SEG.PRE_PRIMARY,
    assignments: [cls(3, ABC)],
  },
  {
    codeSuffix: '02-0066',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'JUNIOR I',
    segmentId: SEG.JUNIOR,
    assignments: [cls(4, ABC)],
  },
  {
    codeSuffix: '02-0055',
    jobTitle: 'CLASS TEACHER',
    jobDescription: 'JUNIOR II',
    segmentId: SEG.JUNIOR,
    assignments: [cls(5, ABC)],
  },
  {
    codeSuffix: '02-0070',
    jobTitle: 'MATHEMATICS TEACHER',
    jobDescription: 'MATHS, URDU, SOCIAL STUDIES JUNIOR III–V',
    segmentId: SEG.JUNIOR,
    assignments: allSections([6, 7, 8], ABC),
  },
  {
    codeSuffix: '02-0072',
    jobTitle: 'ENGLISH TEACHER',
    jobDescription: 'ENGLISH JUNIOR III–V',
    segmentId: SEG.JUNIOR,
    assignments: allSections([6, 7, 8], ABC),
  },
  {
    codeSuffix: '02-0053',
    jobTitle: 'SCIENCE TEACHER',
    jobDescription: 'SCIENCE, URDU, ISLAMIYAT JUNIOR III–V',
    segmentId: SEG.JUNIOR,
    assignments: allSections([6, 7, 8], ABC),
  },
];

async function findEmployeeByCodeSuffix(codeSuffix: string) {
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
    const exact = candidates.find((c) => c.employee_code?.toUpperCase() === suffix);
    if (exact) return exact;
    return candidates.find((c) => c.employee_code?.toUpperCase().endsWith(suffix)) ?? null;
  }
  return null;
}

async function resolveCategoryId(code: StaffCategoryCode): Promise<number | null> {
  const row = await prisma.staff_categories.findFirst({ where: { code } });
  return row?.id ?? null;
}

async function resolveDepartmentId(): Promise<number | null> {
  const row = await prisma.departments.findFirst({ where: { name: 'ACADEMICS' } });
  return row?.id ?? null;
}

async function applyRow(
  row: AllocationRow,
  departmentId: number | null,
  categoryIds: Record<StaffCategoryCode, number | null>,
): Promise<{ action: string; code: string; name: string }> {
  if (row.skip) {
    return { action: 'skip', code: row.codeSuffix ?? '?', name: row.skipReason ?? 'skipped' };
  }

  let employeeCode: string;
  let employeeId: number;
  let fullName: string;
  let action: string;

  if (row.codeSuffix) {
    const existing = await findEmployeeByCodeSuffix(row.codeSuffix);
    if (!existing) {
      return { action: 'missing', code: row.codeSuffix, name: 'employee not found' };
    }
    employeeId = existing.id;
    employeeCode = existing.employee_code ?? row.codeSuffix;
    fullName = existing.full_name ?? row.codeSuffix;
    action = 'update';
  } else if (row.create) {
    const { fullName: name, campusId, dep = '02', codeNumber, staffCategory = 'TEACHER' } = row.create;
    const prefix = campusPrefixForId(campusId);
    employeeCode = composeEmployeeCode(dep, codeNumber, prefix);
    const existing = await prisma.employee_profiles.findFirst({ where: { employee_code: employeeCode } });
    if (existing) {
      employeeId = existing.id;
      fullName = existing.full_name ?? name;
      action = 'update';
    } else {
      if (DRY_RUN) {
        return { action: 'create', code: employeeCode, name };
      }
      const created = await prisma.employee_profiles.create({
        data: {
          employee_code: employeeCode,
          employee_code_dep: dep,
          employee_code_number: codeNumber,
          full_name: name,
          campus_id: campusId,
          department_id: departmentId,
          staff_category_id: categoryIds[staffCategory],
          job_title: row.jobTitle,
          job_description: row.jobDescription,
          segment_id: row.segmentId ?? null,
          reporting_time: new Date('1970-01-01T07:30:00Z'),
          leaving_time: new Date('1970-01-01T14:20:00Z'),
          late_relaxation_minutes: 5,
          days_per_week: 5,
        },
      });
      employeeId = created.id;
      fullName = name;
      action = 'create';
    }
  } else {
    return { action: 'skip', code: '?', name: 'no code or create spec' };
  }

  const pairCount = expandAssignments(row.assignments).length;

  if (DRY_RUN) {
    return { action, code: employeeCode, name: `${fullName} (${pairCount} pairs)` };
  }

  await prisma.employee_profiles.update({
    where: { id: employeeId },
    data: {
      job_title: row.jobTitle,
      job_description: row.jobDescription,
      segment_id: row.segmentId !== undefined ? row.segmentId : undefined,
    },
  });

  await prisma.employee_class_section_assignments.deleteMany({ where: { employee_id: employeeId } });
  const pairs = expandAssignments(row.assignments);
  if (pairs.length) {
    await prisma.employee_class_section_assignments.createMany({
      data: pairs.map((p) => ({ employee_id: employeeId, ...p })),
    });
  }

  return { action, code: employeeCode, name: fullName };
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN (no writes) ===\n' : '=== APPLYING TEACHER ALLOCATIONS ===\n');

  const departmentId = await resolveDepartmentId();
  const categoryIds: Record<StaffCategoryCode, number | null> = {
    TEACHER: await resolveCategoryId('TEACHER'),
    ASSISTANT_TEACHER: await resolveCategoryId('ASSISTANT_TEACHER'),
    SPORTS_COACH: await resolveCategoryId('SPORTS_COACH'),
    SCOUT_LEADER: await resolveCategoryId('SCOUT_LEADER'),
  };

  const results: { action: string; code: string; name: string }[] = [];
  for (const row of ALLOCATIONS) {
    const result = await applyRow(row, departmentId, categoryIds);
    results.push(result);
    console.log(`  [${result.action.toUpperCase()}] ${result.code} — ${result.name}`);
  }

  const summary = results.reduce(
    (acc, r) => {
      acc[r.action] = (acc[r.action] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  console.log('\n--- Summary ---');
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);

  if (DRY_RUN) {
    console.log('\nRun with DRY_RUN=false to apply changes.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

/** Build override map keyed by unprefixed employee code (02-xxxxx). */
export function buildOverrideMap(): Record<string, ClassSectionAssignment[]> {
  const map: Record<string, ClassSectionAssignment[]> = {};
  for (const row of ALLOCATIONS) {
    if (row.skip || !row.assignments.length) continue;
    let key: string | null = null;
    if (row.codeSuffix) key = overrideKey(row.codeSuffix);
    else if (row.create) {
      key = `${row.create.dep ?? '02'}-${row.create.codeNumber}`;
    }
    if (key) map[key] = row.assignments;
  }
  return map;
}
