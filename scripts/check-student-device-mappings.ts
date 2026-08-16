/**
 * Audits student device_user_mappings for two data-quality issues:
 *   1. device_pin does not match the student's cc (they're supposed to be equal).
 *   2. A student has more than one mapping row, counting active + inactive.
 *
 * Usage: npx ts-node scripts/check-student-device-mappings.ts
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

const CSV_PATH = join(__dirname, '../../student-device-mapping-audit.csv');

function csvEscape(value: string | number | boolean): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const mappings = await prisma.device_user_mappings.findMany({
    where: { student_cc: { not: null } },
    select: {
      id: true,
      device_sn: true,
      device_pin: true,
      is_active: true,
      display_name: true,
      student_cc: true,
      students: {
        select: { cc: true, full_name: true, gr_number: true, campus_id: true },
      },
    },
    orderBy: [{ student_cc: 'asc' }, { id: 'asc' }],
  });

  console.log(`Scanned ${mappings.length} student device mapping(s).\n`);

  // ── Check 1: device_pin !== cc ──────────────────────────────────────────
  const pinMismatches = mappings.filter((m) => m.device_pin.trim() !== String(m.student_cc));

  console.log(`=== PIN ≠ CC mismatches (${pinMismatches.length}) ===`);
  for (const m of pinMismatches) {
    console.log(
      `  mapping #${m.id} | cc=${m.student_cc} pin="${m.device_pin}" | sn=${m.device_sn} | active=${m.is_active} | ${m.students?.full_name ?? '(no student?)'} (GR ${m.students?.gr_number ?? '—'})`,
    );
  }
  if (pinMismatches.length === 0) console.log('  none');

  // ── Check 2: student with more than one mapping ─────────────────────────
  const byStudent = new Map<number, typeof mappings>();
  for (const m of mappings) {
    if (m.student_cc == null) continue;
    const list = byStudent.get(m.student_cc) ?? [];
    list.push(m);
    byStudent.set(m.student_cc, list);
  }
  const duplicates = [...byStudent.entries()].filter(([, list]) => list.length > 1);

  console.log(`\n=== Students with multiple mappings (${duplicates.length}) ===`);
  for (const [cc, list] of duplicates) {
    const name = list[0].students?.full_name ?? '(no student?)';
    const gr = list[0].students?.gr_number ?? '—';
    console.log(`  cc=${cc} | ${name} (GR ${gr}) | ${list.length} mappings:`);
    for (const m of list) {
      console.log(`    - mapping #${m.id} | pin="${m.device_pin}" | sn=${m.device_sn} | active=${m.is_active}`);
    }
  }
  if (duplicates.length === 0) console.log('  none');

  console.log(
    `\nSummary: ${pinMismatches.length} pin/cc mismatch(es), ${duplicates.length} student(s) with duplicate mappings.`,
  );

  // ── CSV export ───────────────────────────────────────────────────────────
  const pinMismatchIds = new Set(pinMismatches.map((m) => m.id));
  const duplicateIds = new Set(duplicates.flatMap(([, list]) => list.map((m) => m.id)));

  const header = [
    'issue_type',
    'mapping_id',
    'student_cc',
    'gr_number',
    'student_name',
    'device_pin',
    'device_sn',
    'is_active',
  ];
  const rows: string[][] = [];
  for (const m of mappings) {
    const issues: string[] = [];
    if (pinMismatchIds.has(m.id)) issues.push('PIN_MISMATCH');
    if (duplicateIds.has(m.id)) issues.push('DUPLICATE_MAPPING');
    if (issues.length === 0) continue;
    rows.push([
      issues.join('+'),
      String(m.id),
      String(m.student_cc),
      m.students?.gr_number ?? '',
      m.students?.full_name ?? '',
      m.device_pin,
      m.device_sn,
      String(m.is_active),
    ]);
  }

  const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
  writeFileSync(CSV_PATH, csv + '\n');
  console.log(`\nCSV written to ${CSV_PATH} (${rows.length} flagged row(s)).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
