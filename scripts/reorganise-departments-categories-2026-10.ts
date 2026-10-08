/**
 * TAFSD-276 — reorganise staff into Department → Category → Designation, per
 * the school's mapping (9 Oct 2026):
 *
 *   ACADEMICS         Teacher, Assistant Teacher, Academic Coordinator,
 *                     Academic Administrator, Sports Coach, Scout Leader
 *   SUPPORT SERVICES  Support Staff
 *   ADMINISTRATION    Administrative Staff, Senior Leadership, Finance Staff,
 *                     IT Staff, Creative Staff
 *
 * Designation stays employee_profiles.job_title (e.g. Support Services →
 * Support Staff → Guard). The dry-run CSV of this exact plan was reviewed:
 * department-category-rearrangement-dry-run-2026-10-09.csv.
 *
 * Steps, in one transaction:
 *  1. Move Senior Leadership, Finance Staff, IT Staff and Creative Staff under
 *     ADMINISTRATION (they sat under SENIOR MANAGEMENT, FINANCE, IT & TECHNOLOGY).
 *  2. Give the 12 employees with no department/category the category suggested
 *     from their job title in the dry run.
 *  3. Set every employee's department to their category's department.
 *  4. Repoint employee_progression_periods off the retired departments, and
 *     bring the 12 employees' open periods in line with their profile.
 *  5. Delete the now-empty SENIOR MANAGEMENT, FINANCE and IT & TECHNOLOGY
 *     departments and the unused VISITING FACULTY category (plus its one scope
 *     entry — that user keeps their Teacher category scope).
 *     employee_profiles / progression FKs are ON DELETE SET NULL and
 *     academic_calendar_days ON DELETE CASCADE, so this refuses to delete
 *     anything still referenced rather than let the database null it out.
 *  6. One audit rollup + a child row per employee whose department or
 *     category changed.
 *
 * Not touched: employee codes (the category's employee_code_dep is unchanged),
 * the test record TEST-ALEVEL (id 321).
 *
 * DRY RUN BY DEFAULT. Pass --commit to write.
 * Usage: npx ts-node scripts/reorganise-departments-categories-2026-10.ts [--commit]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const CHANGED_BY = 'script:reorganise-departments-categories (TAFSD-276)';

const DEPT = { ACADEMICS: 6, ADMINISTRATION: 10, SUPPORT_SERVICES: 11 } as const;
const RETIRED_DEPARTMENTS = [7, 8, 9]; // SENIOR MANAGEMENT, FINANCE, IT & TECHNOLOGY
const RETIRED_CATEGORIES = [13]; // VISITING_FACULTY

/** category code → department it belongs to after the reorganisation. */
const CATEGORY_DEPARTMENT: Record<string, number> = {
  TEACHER: DEPT.ACADEMICS,
  ASSISTANT_TEACHER: DEPT.ACADEMICS,
  ACADEMIC_COORDINATOR: DEPT.ACADEMICS,
  ACADEMIC_ADMINISTRATOR: DEPT.ACADEMICS,
  SPORTS_COACH: DEPT.ACADEMICS,
  SCOUT_LEADER: DEPT.ACADEMICS,
  SUPPORT_STAFF: DEPT.SUPPORT_SERVICES,
  ADMINISTRATIVE_STAFF: DEPT.ADMINISTRATION,
  SENIOR_LEADERSHIP: DEPT.ADMINISTRATION,
  FINANCE_STAFF: DEPT.ADMINISTRATION,
  IT_STAFF: DEPT.ADMINISTRATION,
  CREATIVE_STAFF: DEPT.ADMINISTRATION,
};

/** Employees with no category today → category suggested from job title (dry run). */
const UNCATEGORISED: Record<number, string> = {
  212: 'SENIOR_LEADERSHIP', // campus head
  213: 'SENIOR_LEADERSHIP', // campus head
  214: 'ADMINISTRATIVE_STAFF', // admin assistant
  215: 'ACADEMIC_COORDINATOR', // academic co-ordinator
  216: 'SUPPORT_STAFF', // guard
  217: 'SUPPORT_STAFF', // domestic supervisor
  218: 'ADMINISTRATIVE_STAFF', // F.D.O / office assistant
  219: 'ADMINISTRATIVE_STAFF', // computer operator
  220: 'ASSISTANT_TEACHER', // co-teacher KG
  221: 'TEACHER', // class teacher
  222: 'SUPPORT_STAFF', // guard
  223: 'SUPPORT_STAFF', // electrician
};

async function main() {
  console.log(COMMIT ? 'MODE: COMMIT — rows will be written\n' : 'MODE: DRY RUN — nothing will be written\n');

  const [departments, categories, employees] = await Promise.all([
    prisma.departments.findMany({ orderBy: { id: 'asc' } }),
    prisma.staff_categories.findMany({ orderBy: { id: 'asc' } }),
    prisma.employee_profiles.findMany({
      select: { id: true, employee_code: true, full_name: true, department_id: true, staff_category_id: true },
      orderBy: { id: 'asc' },
    }),
  ]);
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const catByCode = new Map(categories.map((c) => [c.code, c]));
  const catById = new Map(categories.map((c) => [c.id, c]));

  for (const id of Object.values(DEPT)) {
    if (!deptName.has(id)) throw new Error(`Department #${id} missing — aborting.`);
  }
  for (const code of Object.keys(CATEGORY_DEPARTMENT)) {
    if (!catByCode.has(code)) throw new Error(`Category ${code} missing — aborting.`);
  }

  // 1. categories whose department changes
  const categoryMoves = categories
    .filter((c) => CATEGORY_DEPARTMENT[c.code] != null && c.department_id !== CATEGORY_DEPARTMENT[c.code])
    .map((c) => ({ id: c.id, name: c.name, from: c.department_id, to: CATEGORY_DEPARTMENT[c.code] }));
  console.log('Category moves:');
  for (const m of categoryMoves) console.log(`  ${m.name}: ${deptName.get(m.from)} → ${deptName.get(m.to)}`);

  // 2+3. per-employee target
  type Change = { id: number; code: string | null; name: string | null; fromDept: number | null; toDept: number; fromCat: number | null; toCat: number };
  const changes: Change[] = [];
  const unmapped: string[] = [];
  for (const e of employees) {
    let catId = e.staff_category_id;
    if (catId == null && UNCATEGORISED[e.id]) catId = catByCode.get(UNCATEGORISED[e.id])!.id;
    if (catId == null) {
      unmapped.push(`#${e.id} ${e.employee_code ?? ''} ${e.full_name ?? ''}`);
      continue;
    }
    const cat = catById.get(catId)!;
    const toDept = CATEGORY_DEPARTMENT[cat.code];
    if (toDept == null) {
      unmapped.push(`#${e.id} ${e.full_name ?? ''} — category ${cat.code} not in the mapping`);
      continue;
    }
    if (e.department_id !== toDept || e.staff_category_id !== catId) {
      changes.push({ id: e.id, code: e.employee_code, name: e.full_name, fromDept: e.department_id, toDept, fromCat: e.staff_category_id, toCat: catId });
    }
  }
  console.log(`\nEmployees changing department/category: ${changes.length}`);
  for (const c of changes) {
    console.log(
      `  #${c.id} ${c.code ?? ''} ${c.name ?? ''}: ${deptName.get(c.fromDept ?? -1) ?? '(none)'} / ${catById.get(c.fromCat ?? -1)?.name ?? '(none)'}` +
        ` → ${deptName.get(c.toDept)} / ${catById.get(c.toCat)!.name}`,
    );
  }
  console.log(`Left as is (no category, not in the plan): ${unmapped.length}`);
  for (const u of unmapped) console.log(`  ${u}`);

  // 4. progression periods on retired departments
  const periodsOnRetired = await prisma.employee_progression_periods.count({
    where: { department_id: { in: RETIRED_DEPARTMENTS } },
  });
  console.log(`\nProgression periods to repoint off retired departments: ${periodsOnRetired}`);
  console.log(`Delete departments: ${RETIRED_DEPARTMENTS.map((id) => deptName.get(id)).join(', ')}`);
  console.log(`Delete categories: ${RETIRED_CATEGORIES.map((id) => catById.get(id)?.name).join(', ')}`);

  if (!COMMIT) {
    console.log('\nDry run — re-run with --commit to apply.');
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      for (const m of categoryMoves) {
        await tx.staff_categories.update({ where: { id: m.id }, data: { department_id: m.to } });
      }
      for (const c of changes) {
        await tx.employee_profiles.update({
          where: { id: c.id },
          data: { department_id: c.toDept, staff_category_id: c.toCat },
        });
        // Their current (open) progression period describes them now — keep it
        // in step. A reorganisation, not a career event, so no new period.
        await tx.employee_progression_periods.updateMany({
          where: { employee_id: c.id, valid_to: null },
          data: { department_id: c.toDept, staff_category_id: c.toCat },
        });
      }
      // History on the retired departments: the same categories now live under
      // ADMINISTRATION, so point the old rows there before the departments go.
      for (const m of categoryMoves) {
        await tx.employee_progression_periods.updateMany({
          where: { staff_category_id: m.id, department_id: { in: RETIRED_DEPARTMENTS } },
          data: { department_id: m.to },
        });
      }

      // Nothing may still point at what is about to be deleted.
      const [empDept, perDept, calDept, catDept, empCat, perCat, calCat] = await Promise.all([
        tx.employee_profiles.count({ where: { department_id: { in: RETIRED_DEPARTMENTS } } }),
        tx.employee_progression_periods.count({ where: { department_id: { in: RETIRED_DEPARTMENTS } } }),
        tx.academic_calendar_days.count({ where: { department_id: { in: RETIRED_DEPARTMENTS } } }),
        tx.staff_categories.count({ where: { department_id: { in: RETIRED_DEPARTMENTS } } }),
        tx.employee_profiles.count({ where: { staff_category_id: { in: RETIRED_CATEGORIES } } }),
        tx.employee_progression_periods.count({ where: { staff_category_id: { in: RETIRED_CATEGORIES } } }),
        tx.academic_calendar_days.count({ where: { staff_category_id: { in: RETIRED_CATEGORIES } } }),
      ]);
      const left = { empDept, perDept, calDept, catDept, empCat, perCat, calCat };
      if (Object.values(left).some((n) => n > 0)) {
        throw new Error(`Still referenced, rolling back: ${JSON.stringify(left)}`);
      }

      await tx.user_scope_entries.deleteMany({
        where: {
          OR: [
            { dimension: 'DEPARTMENT', ref_id: { in: RETIRED_DEPARTMENTS } },
            { dimension: 'STAFF_CATEGORY', ref_id: { in: RETIRED_CATEGORIES } },
          ],
        },
      });
      await tx.staff_categories.deleteMany({ where: { id: { in: RETIRED_CATEGORIES } } });
      await tx.departments.deleteMany({ where: { id: { in: RETIRED_DEPARTMENTS } } });

      const parent = await tx.audit_logs.create({
        data: {
          entity_type: 'DEPARTMENT',
          entity_id: 'reorganisation-2026-10',
          action: 'UPDATED',
          section: 'hr',
          changed_by: CHANGED_BY,
          note:
            `TAFSD-276: Department → Category reorganisation. Moved ${categoryMoves.map((m) => m.name).join(', ')} under ADMINISTRATION; ` +
            `${changes.length} employee(s) re-filed; deleted departments ${RETIRED_DEPARTMENTS.map((id) => deptName.get(id)).join(', ')} ` +
            `and category ${RETIRED_CATEGORIES.map((id) => catById.get(id)?.name).join(', ')}.`,
        },
      });
      await tx.audit_logs.createMany({
        data: changes.map((c) => ({
          entity_type: 'EMPLOYEE',
          entity_id: String(c.id),
          action: 'UPDATED',
          section: 'hr',
          field: 'Department / Category',
          old_value: `${deptName.get(c.fromDept ?? -1) ?? '(none)'} / ${catById.get(c.fromCat ?? -1)?.name ?? '(none)'}`,
          new_value: `${deptName.get(c.toDept)} / ${catById.get(c.toCat)!.name}`,
          changed_by: CHANGED_BY,
          parent_id: parent.id,
          note: `TAFSD-276 reorganisation${UNCATEGORISED[c.id] ? ' — category suggested from job title' : ''}.`,
        })),
      });
      console.log(`\nApplied. Audit rollup #${parent.id}.`);
    },
    { maxWait: 30_000, timeout: 120_000 },
  );

  const after = await prisma.departments.findMany({
    include: { staff_categories: { select: { name: true } }, _count: { select: { employee_profiles: true } } },
    orderBy: { id: 'asc' },
  });
  console.log('\nAfter:');
  for (const d of after) {
    console.log(`  ${d.name} (${d._count.employee_profiles} employees): ${d.staff_categories.map((c) => c.name).join(', ')}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
