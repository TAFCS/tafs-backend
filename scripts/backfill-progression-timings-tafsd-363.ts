/**
 * TAFSD-363: put timings on the employee progression timeline retroactively.
 *
 *   npx ts-node --transpile-only scripts/backfill-progression-timings-tafsd-363.ts          # dry run
 *   npx ts-node --transpile-only scripts/backfill-progression-timings-tafsd-363.ts --apply  # write
 *
 * 1. Rebuilds each employee's timings backwards from their current values,
 *    undoing every timing edit in the audit log ("Expected Check-in: 07:30 →
 *    07:00", "Late Relaxation (min): 5 → 6", "Working Days / Week", "Check-in
 *    Source"). Those notes exist from 29 Sep 2026 on; before that, timings are
 *    taken to be what they were at the first recorded edit.
 * 2. Splits the period open at each edit and starts a TIMING_CHANGED period
 *    there, copying the other fields, so the change shows in the Progression tab.
 * 3. Writes the timings in effect onto every period that has none.
 *
 * Working-day patterns and per-weekday timings have no usable history (the old
 * "work schedule cleared" entries don't say what was cleared, and per-weekday
 * timings are new), so every period gets the employee's current ones.
 * Safe to re-run: periods that already carry timings are left alone, and an
 * edit is not split twice.
 */
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { timingsSnapshotFrom, type EmployeeTimingsSnapshot } from '../src/modules/hr/employees/employee-day-timings.util';

const APPLY = process.argv.includes('--apply');

const LABELS: Record<string, keyof EmployeeTimingsSnapshot> = {
  'Expected Check-in': 'reporting_time',
  'Expected Check-out': 'leaving_time',
  'Late Relaxation (min)': 'late_relaxation_minutes',
  'Working Days / Week': 'days_per_week',
  'Check-in Source': 'check_in_source',
};
const NUMERIC = new Set<keyof EmployeeTimingsSnapshot>(['late_relaxation_minutes', 'days_per_week']);

type Change = { key: keyof EmployeeTimingsSnapshot; from: unknown; to: unknown; text: string };
type Edit = { at: Date; by: string; changes: Change[] };

function parseValue(key: keyof EmployeeTimingsSnapshot, raw: string): unknown {
  const v = raw.trim();
  if (v === '' || v === '—' || v === '-') return null;
  return NUMERIC.has(key) ? Number(v) : v;
}

/** "NAME — Expected Check-in: 07:30 → 07:00 | Late Relaxation (min): 5 → 6" → its timing changes. */
function parseNote(note: string): Change[] {
  const body = note.includes(' — ') ? note.slice(note.indexOf(' — ') + 3) : note;
  const out: Change[] = [];
  for (const part of body.split(' | ')) {
    const m = part.match(/^(.+?): (.*) → (.*)$/);
    if (!m) continue;
    const key = LABELS[m[1].trim()];
    if (!key) continue;
    out.push({ key, from: parseValue(key, m[2]), to: parseValue(key, m[3]), text: part.trim() });
  }
  return out;
}

(async () => {
  const prisma = new PrismaService();
  const logs = await prisma.audit_logs.findMany({
    where: { entity_type: 'EMPLOYEE', action: 'UPDATED', note: { contains: ' → ' } },
    select: { entity_id: true, changed_at: true, changed_by: true, note: true },
    orderBy: { changed_at: 'asc' },
  });
  const editsByEmployee = new Map<number, Edit[]>();
  for (const l of logs) {
    const changes = parseNote(l.note ?? '');
    if (!changes.length) continue;
    const id = Number(l.entity_id);
    const list = editsByEmployee.get(id) ?? [];
    list.push({ at: l.changed_at, by: l.changed_by, changes });
    editsByEmployee.set(id, list);
  }

  const employees = await prisma.employee_profiles.findMany({
    where: { employee_progression_periods: { some: {} } },
    select: {
      id: true,
      full_name: true,
      check_in_source: true,
      reporting_time: true,
      leaving_time: true,
      late_relaxation_minutes: true,
      days_per_week: true,
      employee_work_schedules: { select: { day_of_week: true, is_working: true } },
      employee_day_timings: { select: { day_of_week: true, reporting_time: true, leaving_time: true } },
    },
  });

  let filled = 0;
  let split = 0;
  for (const emp of employees) {
    const edits = editsByEmployee.get(emp.id) ?? [];
    // States between edits, newest first: undo each edit from today's values.
    const current = timingsSnapshotFrom(emp);
    const after: EmployeeTimingsSnapshot[] = [];
    let state: EmployeeTimingsSnapshot = { ...current };
    for (let i = edits.length - 1; i >= 0; i--) {
      after[i] = { ...state };
      const undone = { ...state } as Record<string, unknown>;
      for (const c of edits[i].changes) undone[c.key] = c.from;
      state = undone as EmployeeTimingsSnapshot;
    }
    const initial = state;
    const stateAt = (t: Date) => {
      let s = initial;
      edits.forEach((e, i) => {
        if (e.at.getTime() <= t.getTime()) s = after[i];
      });
      return s;
    };

    // Split the period open at each edit, oldest first.
    for (const [i, edit] of edits.entries()) {
      const periods = await prisma.employee_progression_periods.findMany({
        where: { employee_id: emp.id },
        orderBy: { valid_from: 'asc' },
      });
      const p = periods.find(
        (x) => x.valid_from.getTime() <= edit.at.getTime() && (x.valid_to == null || x.valid_to.getTime() > edit.at.getTime()),
      );
      if (!p) continue;
      const already = periods.some(
        (x) => x.change_type === 'TIMING_CHANGED' && Math.abs(x.valid_from.getTime() - edit.at.getTime()) < 1000,
      );
      if (already || p.valid_from.getTime() === edit.at.getTime()) continue;
      const notes = edit.changes.map((c) => c.text).join(' | ').slice(0, 255);
      console.log(`${emp.full_name} (#${emp.id}): split period ${p.id} at ${edit.at.toISOString()} — ${notes}`);
      split++;
      if (!APPLY) continue;
      const { id: _id, valid_from: _vf, valid_to, change_type: _ct, changed_by: _cb, notes: _n, timings: _t, ...dims } = p;
      await prisma.$transaction([
        prisma.employee_progression_periods.update({ where: { id: p.id }, data: { valid_to: edit.at } }),
        prisma.employee_progression_periods.create({
          data: {
            ...dims,
            class_sections: (dims.class_sections ?? Prisma.DbNull) as Prisma.InputJsonValue,
            change_type: 'TIMING_CHANGED',
            changed_by: edit.by,
            notes,
            timings: after[i] as unknown as Prisma.InputJsonValue,
            valid_from: edit.at,
            valid_to,
          },
        }),
      ]);
    }

    // Timings on every period still without them.
    const periods = await prisma.employee_progression_periods.findMany({ where: { employee_id: emp.id, timings: { equals: Prisma.DbNull } } });
    for (const p of periods) {
      filled++;
      if (APPLY) {
        await prisma.employee_progression_periods.update({
          where: { id: p.id },
          data: { timings: stateAt(p.valid_from) as unknown as Prisma.InputJsonValue },
        });
      }
    }
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${split} timing-change period(s) inserted, ${filled} period(s) given timings, ${employees.length} employees.`);
  await prisma.$disconnect();
})();
