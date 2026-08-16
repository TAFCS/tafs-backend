/**
 * Fixes student device_user_mappings where device_pin was accidentally set to
 * the student's gr_number instead of their cc.
 *
 * Categorizes every gr_number-mistake row:
 *   A. SOLE_MAPPING       — student's only mapping row; safe to repin pin -> cc.
 *   B. SAFE_DUPLICATE     — student already has another row with the correct
 *                           cc pin, but on a *different* device_sn; safe to
 *                           repin (becomes a second valid device enrollment).
 *   C. COLLISION_DUPLICATE — a sibling row already has cc as the pin on the
 *                           *same* device_sn; repinning would violate the
 *                           (device_sn, device_pin) unique constraint. These
 *                           are left untouched — printed for manual review
 *                           (likely just need deactivating, not repinning).
 *
 * Dry-run by default — only prints the plan and writes a CSV. Pass --apply to
 * actually UPDATE categories A and B. Category C is never auto-applied.
 *
 * Usage:
 *   npx ts-node scripts/fix-student-device-pin-gr-mismatch.ts            (dry run)
 *   npx ts-node scripts/fix-student-device-pin-gr-mismatch.ts --apply    (apply A+B)
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const CATEGORY_ARG = process.argv.find((a) => a.startsWith('--categories='));
const APPLY_CATEGORIES = new Set((CATEGORY_ARG ? CATEGORY_ARG.split('=')[1] : 'A,B').split(','));
const CSV_PATH = join(__dirname, '../../student-device-pin-gr-fix-plan.csv');

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
      student_cc: true,
      students: { select: { cc: true, full_name: true, gr_number: true } },
    },
  });

  const byStudent = new Map<number, typeof mappings>();
  for (const m of mappings) {
    if (m.student_cc == null) continue;
    const list = byStudent.get(m.student_cc) ?? [];
    list.push(m);
    byStudent.set(m.student_cc, list);
  }

  const grMistakes = mappings.filter((m) => {
    const gr = (m.students?.gr_number ?? '').trim();
    return gr && m.device_pin.trim() === gr;
  });

  type Plan = { m: (typeof mappings)[number]; category: 'A' | 'B' | 'C' };
  const plan: Plan[] = [];

  for (const m of grMistakes) {
    const siblings = (byStudent.get(m.student_cc!) ?? []).filter((x) => x.id !== m.id);
    const correctSibling = siblings.find((s) => s.device_pin.trim() === String(m.student_cc));
    if (!correctSibling) {
      plan.push({ m, category: 'A' });
    } else if (correctSibling.device_sn === m.device_sn) {
      plan.push({ m, category: 'C' });
    } else {
      plan.push({ m, category: 'B' });
    }
  }

  const byCat = { A: plan.filter((p) => p.category === 'A'), B: plan.filter((p) => p.category === 'B'), C: plan.filter((p) => p.category === 'C') };

  console.log(`Found ${grMistakes.length} rows where device_pin was mistakenly set to the student's gr_number.\n`);
  console.log(`  A. Sole mapping, safe to repin: ${byCat.A.length}`);
  console.log(`  B. Has correct sibling on a different device, safe to repin: ${byCat.B.length}`);
  console.log(`  C. Collides with a correct sibling on the SAME device — needs manual review, NOT auto-fixed: ${byCat.C.length}\n`);

  if (byCat.C.length > 0) {
    console.log('=== Category C (manual review) ===');
    for (const { m } of byCat.C) {
      console.log(
        `  mapping #${m.id} | cc=${m.student_cc} pin="${m.device_pin}" (=gr) | sn=${m.device_sn} | active=${m.is_active} | ${m.students?.full_name}`,
      );
    }
    console.log('  These likely just need deactivating (a correct row already covers that device), not repinning.\n');
  }

  // CSV of the full plan
  const header = ['category', 'mapping_id', 'student_cc', 'gr_number', 'student_name', 'device_sn', 'old_pin', 'new_pin', 'is_active', 'action'];
  const rows = plan.map(({ m, category }) => [
    category,
    String(m.id),
    String(m.student_cc),
    m.students?.gr_number ?? '',
    m.students?.full_name ?? '',
    m.device_sn,
    m.device_pin,
    category === 'C' ? m.device_pin : String(m.student_cc),
    String(m.is_active),
    category === 'C' ? 'MANUAL_REVIEW' : APPLY ? 'UPDATED' : 'PLANNED',
  ]);
  writeFileSync(CSV_PATH, [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n') + '\n');
  console.log(`Plan written to ${CSV_PATH}`);

  if (!APPLY) {
    console.log('\nDry run only — no rows were changed. Re-run with --apply (optionally --categories=A,B) to update.');
    return;
  }

  const toApply = plan.filter((p) => APPLY_CATEGORIES.has(p.category));
  console.log(`\nApplying fix to ${toApply.length} row(s) (categories ${[...APPLY_CATEGORIES].join(',')})...`);
  let updated = 0;
  for (const { m } of toApply) {
    await prisma.device_user_mappings.update({
      where: { id: m.id },
      data: { device_pin: String(m.student_cc) },
    });
    updated++;
  }
  console.log(`Updated ${updated} row(s). Skipped: ${plan.length - updated}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
