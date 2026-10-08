/**
 * TAFSD-272 — MUHAMMAD AHMED (employee #200, GEJ-04-0050139): move his
 * reinstate date back by one calendar day.
 *
 * He went LEFT -> ACTIVE on 2026-09-30 10:43 (server time), before the
 * status change asked for a "date of rejoining". So join_date was never
 * rewritten (still the original 2026-07-07), and the only place his
 * reinstatement is recorded is the progression boundary: the old period's
 * valid_to and the new ACTIVE period's valid_from, both stamped with the
 * moment of the click. Payroll's tenure window (tenure-window.util) starts his
 * current window on that valid_from's date, so it is the reinstate date in
 * effect. The real one was a day earlier.
 *
 * Moves BOTH sides of that boundary back exactly one day, keeping them equal
 * (valid_to is the exclusive upper bound and the next period opens on the same
 * timestamp). join_date is left alone — it is his original joining date.
 * Writes one audit_logs row (entity EMPLOYEE).
 *
 * Safe to re-run: it refuses unless the boundary is still at the value it was
 * found at on 2026-10-07.
 *
 * DRY RUN BY DEFAULT. Pass --commit to write.
 * Usage: npx ts-node scripts/fix-m-ahmed-reinstate-date.ts [--commit]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');

const EMPLOYEE_ID = 200;
const EMPLOYEE_CODE = 'GEJ-04-0050139';
/** The ACTIVE period opened by the reinstatement, and the one it closed. */
const REINSTATED_PERIOD_ID = 317;
const PREVIOUS_PERIOD_ID = 111;
/** The boundary as found on 2026-10-07 (timestamp without time zone). */
const EXPECTED_BOUNDARY = '2026-09-30 10:43:50.746';
const DAY_MS = 86_400_000;

const fmt = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').replace('Z', '') : 'null');

async function main() {
  console.log(COMMIT ? 'MODE: COMMIT — rows will be written\n' : 'MODE: DRY RUN — nothing will be written\n');

  const emp = await prisma.employee_profiles.findUnique({
    where: { id: EMPLOYEE_ID },
    select: { id: true, employee_code: true, full_name: true, employment_status: true, join_date: true, date_of_leaving: true },
  });
  if (!emp || emp.employee_code !== EMPLOYEE_CODE) {
    throw new Error(`Employee #${EMPLOYEE_ID} is not ${EMPLOYEE_CODE} (found ${emp?.employee_code ?? 'nothing'}).`);
  }
  console.log(`${emp.full_name} (${emp.employee_code}) — ${emp.employment_status}, join_date ${fmt(emp.join_date)}, date_of_leaving ${fmt(emp.date_of_leaving)}`);

  const [reinstated, previous] = await Promise.all([
    prisma.employee_progression_periods.findUnique({ where: { id: REINSTATED_PERIOD_ID } }),
    prisma.employee_progression_periods.findUnique({ where: { id: PREVIOUS_PERIOD_ID } }),
  ]);
  if (!reinstated || !previous || reinstated.employee_id !== EMPLOYEE_ID || previous.employee_id !== EMPLOYEE_ID) {
    throw new Error('Progression periods are not the ones expected for this employee.');
  }
  console.log(`period #${previous.id}   ${previous.change_type}/${previous.employment_status}  ${fmt(previous.valid_from)} → ${fmt(previous.valid_to)}`);
  console.log(`period #${reinstated.id}   ${reinstated.change_type}/${reinstated.employment_status}  ${fmt(reinstated.valid_from)} → ${fmt(reinstated.valid_to)}`);

  const boundary = reinstated.valid_from;
  if (fmt(boundary) !== EXPECTED_BOUNDARY || fmt(previous.valid_to) !== EXPECTED_BOUNDARY) {
    throw new Error(
      `Boundary is ${fmt(boundary)} / ${fmt(previous.valid_to)}, expected ${EXPECTED_BOUNDARY} on both — already fixed or changed since. Not touching it.`,
    );
  }
  const newBoundary = new Date(boundary.getTime() - DAY_MS);
  console.log(`\nReinstate boundary: ${fmt(boundary)} → ${fmt(newBoundary)}`);

  if (!COMMIT) {
    console.log('\nDry run — re-run with --commit to apply.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.employee_progression_periods.update({
      where: { id: PREVIOUS_PERIOD_ID },
      data: { valid_to: newBoundary },
    });
    await tx.employee_progression_periods.update({
      where: { id: REINSTATED_PERIOD_ID },
      data: { valid_from: newBoundary },
    });
    await tx.audit_logs.create({
      data: {
        entity_type: 'EMPLOYEE',
        entity_id: String(EMPLOYEE_ID),
        action: 'UPDATED',
        section: 'hr',
        field: 'Reinstate Date',
        old_value: boundary.toISOString().slice(0, 10),
        new_value: newBoundary.toISOString().slice(0, 10),
        changed_by: 'script:fix-m-ahmed-reinstate-date (TAFSD-272)',
        note:
          `TAFSD-272: reinstated before the rejoin-date field existed, recorded one day late. ` +
          `Progression boundary (period #${PREVIOUS_PERIOD_ID} valid_to / #${REINSTATED_PERIOD_ID} valid_from) ` +
          `moved ${fmt(boundary)} → ${fmt(newBoundary)}. join_date unchanged.`,
      },
    });
  });

  const after = await prisma.employee_progression_periods.findMany({
    where: { id: { in: [PREVIOUS_PERIOD_ID, REINSTATED_PERIOD_ID] } },
    orderBy: { valid_from: 'asc' },
  });
  console.log('\nAfter:');
  for (const p of after) console.log(`period #${p.id}   ${fmt(p.valid_from)} → ${fmt(p.valid_to)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
