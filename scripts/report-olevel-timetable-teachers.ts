/**
 * Lists O-Level section timetable teachers and whether they qualify for
 * timetable-derived schedule/pay (check_in_source = TIMETABLE).
 *
 * Usage: npx ts-node scripts/report-olevel-timetable-teachers.ts
 */
import { CheckInSource, PrismaClient } from '@prisma/client';

const O_LEVEL_CLASS_IDS = [12, 13, 14];
const prisma = new PrismaClient();

async function main() {
  const slots = await prisma.timetable_slots.findMany({
    where: {
      timetables: {
        is_active: true,
        class_id: { in: O_LEVEL_CLASS_IDS },
        section_id: { not: null },
        teaching_group_id: null,
      },
      employee_profiles: { employment_status: 'ACTIVE' },
    },
    include: {
      employee_profiles: {
        select: {
          id: true,
          full_name: true,
          employee_code: true,
          check_in_source: true,
          campus_id: true,
        },
      },
    },
  });

  const byEmployee = new Map<
    number,
    {
      id: number;
      full_name: string | null;
      employee_code: string | null;
      check_in_source: CheckInSource;
      campus_id: number | null;
      slot_count: number;
    }
  >();

  for (const slot of slots) {
    const emp = slot.employee_profiles;
    if (!emp) continue;
    const row = byEmployee.get(emp.id) ?? {
      id: emp.id,
      full_name: emp.full_name,
      employee_code: emp.employee_code,
      check_in_source: emp.check_in_source,
      campus_id: emp.campus_id,
      slot_count: 0,
    };
    row.slot_count += 1;
    byEmployee.set(emp.id, row);
  }

  const all = [...byEmployee.values()].sort((a, b) =>
    (a.full_name ?? '').localeCompare(b.full_name ?? ''),
  );
  const eligible = all.filter((e) => e.check_in_source === CheckInSource.TIMETABLE);
  const needsHr = all.filter((e) => e.check_in_source !== CheckInSource.TIMETABLE);

  console.log('\n=== Eligible (TIMETABLE + O-Level section slots) ===\n');
  if (eligible.length === 0) {
    console.log('  (none — set check_in_source = TIMETABLE in HR for teachers below)\n');
  } else {
    for (const e of eligible) {
      console.log(
        `  #${e.id} ${e.full_name ?? '—'} (${e.employee_code ?? 'no code'}) — ${e.slot_count} slots`,
      );
    }
    console.log('');
  }

  console.log('=== Has O-Level slots but check_in_source is FIXED (needs HR update) ===\n');
  if (needsHr.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const e of needsHr) {
      console.log(
        `  #${e.id} ${e.full_name ?? '—'} (${e.employee_code ?? 'no code'}) — ${e.slot_count} slots`,
      );
    }
    console.log('');
  }

  console.log(`Total with O-Level slots: ${all.length}`);
  console.log(`Eligible for teacher makeup tab: ${eligible.length}`);
  console.log(`Need HR TIMETABLE flag: ${needsHr.length}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
