/**
 * APPLY employee campus prefixes for real.
 *
 * 1. Assign the 14 campus-less employees to Johar (campus_id=1)
 * 2. Rename employee_code → {GEJ|GKF|NNN}-{existing} for everyone with a campus
 * 3. Leaves employee_code_dep / employee_code_number as the numeric parts
 *
 * Usage:
 *   DRY_RUN=true  node scripts/apply-employee-code-campus-prefix.js   # default
 *   DRY_RUN=false node scripts/apply-employee-code-campus-prefix.js
 */
const { PrismaClient } = require('@prisma/client');

const DRY_RUN = process.env.DRY_RUN !== 'false';

const PREFIX_BY_CAMPUS_ID = {
  1: 'GEJ',
  2: 'GKF',
  3: 'NNN',
};

const JOHAR_UNASSIGNED_IDS = [
  192, 178, 179, 181, 183, 180, 182, 177, 176, 196, 197, 198, 199, 200,
];

const CODE_OVERRIDES = {
  155: 'GEJ-01-0009', // ASIFA OWAIS
};

const p = new PrismaClient();

function propose(code, campusId, id) {
  if (id && CODE_OVERRIDES[id]) return CODE_OVERRIDES[id];
  const prefix = PREFIX_BY_CAMPUS_ID[campusId];
  if (!prefix) return null;
  if (!code) return null;
  if (code.startsWith(`${prefix}-`)) return null; // already done
  if (/^[A-Za-z]/.test(code)) return null; // legacy EMP-/TEST-
  return `${prefix}-${code}`;
}

(async () => {
  console.log(DRY_RUN ? '=== DRY RUN (no writes) ===' : '=== APPLYING FOR REAL ===');

  // 1) Assign Johar to the 14
  const toAssign = await p.employee_profiles.findMany({
    where: { id: { in: JOHAR_UNASSIGNED_IDS } },
    select: { id: true, full_name: true, employee_code: true, campus_id: true },
  });
  console.log(`\nAssign campus_id=1 (Johar) to ${toAssign.length} employees:`);
  for (const e of toAssign) {
    console.log(`  id=${e.id} ${e.full_name} code=${e.employee_code} campus_id=${e.campus_id} → 1`);
  }

  if (!DRY_RUN) {
    const result = await p.employee_profiles.updateMany({
      where: { id: { in: JOHAR_UNASSIGNED_IDS } },
      data: { campus_id: 1 },
    });
    console.log(`  Updated campus_id on ${result.count} rows`);
  }

  // 2) Rename codes
  const employees = await p.employee_profiles.findMany({
    select: {
      id: true,
      full_name: true,
      employee_code: true,
      campus_id: true,
      campuses: { select: { campus_name: true } },
    },
    orderBy: [{ campus_id: 'asc' }, { id: 'asc' }],
  });

  const updates = [];
  for (const e of employees) {
    // After assignment, treat the 14 as Johar even in dry-run preview
    const campusId =
      e.campus_id ??
      (JOHAR_UNASSIGNED_IDS.includes(e.id) ? 1 : null);
    const newCode = propose(e.employee_code, campusId, e.id);
    if (!newCode) continue;
    updates.push({
      id: e.id,
      full_name: e.full_name,
      old_code: e.employee_code,
      new_code: newCode,
      campus_id: campusId,
      campus_name: e.campuses?.campus_name ?? (campusId === 1 ? 'Gulistan-e-Johar Campus' : null),
    });
  }

  console.log(`\nWill rename ${updates.length} employee codes:`);
  const byPrefix = {};
  for (const u of updates) {
    const prefix = u.new_code.split('-')[0];
    byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
  }
  console.log(byPrefix);

  // collision check
  const seen = new Map();
  for (const u of updates) {
    const key = u.new_code.toUpperCase();
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(u.id);
  }
  const collisions = [...seen.entries()].filter(([, ids]) => ids.length > 1);
  if (collisions.length) {
    console.error('COLLISIONS — aborting:', collisions);
    process.exit(1);
  }

  const keepCodes = new Set(
    employees
      .filter((e) => !updates.some((u) => u.id === e.id))
      .map((e) => (e.employee_code || '').toUpperCase())
      .filter(Boolean),
  );
  for (const u of updates) {
    if (keepCodes.has(u.new_code.toUpperCase())) {
      console.error(`COLLISION with existing code ${u.new_code} (id ${u.id})`);
      process.exit(1);
    }
  }

  if (DRY_RUN) {
    console.log('\nSample renames:');
    for (const u of updates.slice(0, 8)) {
      console.log(`  ${u.old_code} → ${u.new_code}  (${u.full_name})`);
    }
    console.log(`  ... and ${Math.max(0, updates.length - 8)} more`);
    console.log('\nSet DRY_RUN=false to apply.');
  } else {
    let ok = 0;
    for (const u of updates) {
      await p.employee_profiles.update({
        where: { id: u.id },
        data: { employee_code: u.new_code },
      });
      ok++;
    }
    console.log(`\nRenamed ${ok} employee codes.`);
  }

  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
