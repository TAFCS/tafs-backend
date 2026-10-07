/**
 * TAFSD-273 — wipe every working-Saturday assignment in the current payroll
 * cycle (2026-09-26 → 2026-10-25, both ends inclusive).
 *
 * The Working Saturdays page showed teachers with a segment on their profile as
 * "No segment assigned" (it only read class-assignment segments), so this
 * cycle's assignments were made off a wrong picture. They are being redone
 * from scratch now that the page shows segments correctly.
 *
 * Deletes teacher_saturday_schedules rows only. Writes one audit_logs rollup
 * row (entity SATURDAY_SCHEDULE) with a child row per deleted assignment, so
 * each removal is traceable to this ticket. Sends no notices — the page's
 * per-assignment "removed" notice would message every teacher about a reset
 * they will be re-assigned through.
 *
 * DRY RUN BY DEFAULT. Pass --commit to write.
 * Usage: npx ts-node scripts/wipe-saturday-schedules-2026-09-26-to-10-25.ts [--commit]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');

const FROM = '2026-09-26';
const TO = '2026-10-25';
const CHANGED_BY = 'script:wipe-saturday-schedules (TAFSD-273)';

async function main() {
  console.log(COMMIT ? 'MODE: COMMIT — rows will be deleted\n' : 'MODE: DRY RUN — nothing will be written\n');

  const where = {
    date: { gte: new Date(`${FROM}T00:00:00.000Z`), lte: new Date(`${TO}T00:00:00.000Z`) },
  };
  const rows = await prisma.teacher_saturday_schedules.findMany({
    where,
    include: { employee_profiles: { select: { full_name: true, employee_code: true, campus_id: true } } },
    orderBy: [{ date: 'asc' }, { employee_id: 'asc' }],
  });

  const key = (d: Date) => d.toISOString().slice(0, 10);
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(key(r.date), (byDate.get(key(r.date)) ?? 0) + 1);
  console.log(`Assignments in ${FROM} → ${TO}: ${rows.length}`);
  for (const [d, n] of byDate) console.log(`  ${d}: ${n}`);

  if (!COMMIT || rows.length === 0) {
    console.log(rows.length === 0 ? '\nNothing to delete.' : '\nDry run — re-run with --commit to delete.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    const parent = await tx.audit_logs.create({
      data: {
        entity_type: 'SATURDAY_SCHEDULE',
        entity_id: `cycle:${FROM}..${TO}`,
        action: 'DELETED',
        section: 'hr',
        changed_by: CHANGED_BY,
        note:
          `TAFSD-273: wiped all ${rows.length} working-Saturday assignment(s) for the payroll cycle ${FROM} → ${TO}. ` +
          'The Working Saturdays page mis-showed profile segments as "No segment", so the cycle is being re-assigned.',
      },
    });
    await tx.audit_logs.createMany({
      data: rows.map((r) => ({
        entity_type: 'SATURDAY_SCHEDULE',
        entity_id: String(r.id),
        action: 'DELETED',
        section: 'hr',
        changed_by: CHANGED_BY,
        parent_id: parent.id,
        old_value: `${key(r.date)} · employee #${r.employee_id} · marked by ${r.marked_by} at ${r.marked_at.toISOString()}`,
        note: `Removed Saturday schedule for ${r.employee_profiles.full_name ?? `employee #${r.employee_id}`} on ${key(r.date)} (TAFSD-273 cycle reset).`,
      })),
    });
    const deleted = await tx.teacher_saturday_schedules.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    if (deleted.count !== rows.length) {
      throw new Error(`Expected to delete ${rows.length}, deleted ${deleted.count} — rolling back.`);
    }
    console.log(`\nDeleted ${deleted.count}. Audit rollup #${parent.id}.`);
  }, { maxWait: 30_000, timeout: 120_000 }); // remote DB over a slow link — the 5s default expires

  const left = await prisma.teacher_saturday_schedules.count({ where });
  console.log(`Remaining in ${FROM} → ${TO}: ${left}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
