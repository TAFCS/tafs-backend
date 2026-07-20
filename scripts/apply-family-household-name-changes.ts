/**
 * apply-family-household-name-changes.ts
 *
 * Updates families.household_name to "FAMILY OF {father_name}" using the same
 * father-resolution rules as the report script.
 *
 * - Families with no resolvable father name are LEFT UNCHANGED.
 * - Families whose name already matches the proposed value are skipped.
 *
 * Usage:
 *   DRY_RUN=true  npx ts-node -r tsconfig-paths/register scripts/apply-family-household-name-changes.ts
 *   DRY_RUN=false npx ts-node -r tsconfig-paths/register scripts/apply-family-household-name-changes.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== 'false';
const MAX_HOUSEHOLD_NAME_LEN = 100;

function normalizeForCompare(v: string): string {
  return v.trim().replace(/\s+/g, ' ').toUpperCase();
}

function csvCell(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function toCSV(headers: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headerLine = headers.map(csvCell).join(',');
  const lines = rows.map((r) =>
    headers.map((h) => csvCell(String(r[h] ?? ''))).join(','),
  );
  return [headerLine, ...lines].join('\r\n') + '\r\n';
}

async function main() {
  const auditDir = path.join(__dirname, '..', 'data-audits');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`═══ APPLY FAMILY HOUSEHOLD NAME CHANGES ═══`);
  console.log(`Mode: ${DRY_RUN ? 'DRY_RUN (no writes)' : 'LIVE WRITE'}\n`);

  const families = await prisma.families.findMany({
    where: { deleted_at: null },
    select: { id: true, household_name: true },
  });

  const fatherLinks = await prisma.student_guardians.findMany({
    where: {
      relationship: { contains: 'Father', mode: 'insensitive' },
    },
    select: {
      students: { select: { family_id: true } },
      guardians: { select: { full_name: true } },
    },
  });

  const familyFatherCounts = new Map<number, Map<string, number>>();
  for (const link of fatherLinks) {
    const familyId = link.students?.family_id;
    if (!familyId) continue;
    const fullName = link.guardians?.full_name?.trim();
    if (!fullName) continue;
    const counts = familyFatherCounts.get(familyId) ?? new Map<string, number>();
    counts.set(fullName, (counts.get(fullName) ?? 0) + 1);
    familyFatherCounts.set(familyId, counts);
  }

  const toUpdate: Array<{
    family_id: number;
    old_household_name: string;
    new_household_name: string;
    father_name_used: string;
  }> = [];
  const skippedUnknown: Array<{ family_id: number; household_name: string }> = [];
  const skippedAlreadyOk: Array<{ family_id: number; household_name: string }> = [];
  const truncated: Array<{ family_id: number; original: string; truncated: string }> = [];

  for (const f of families) {
    const counts = familyFatherCounts.get(f.id);
    if (!counts || counts.size === 0) {
      skippedUnknown.push({ family_id: f.id, household_name: f.household_name });
      continue;
    }

    const variants = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });

    const fatherNameUsed = variants[0].name;
    let newName = `FAMILY OF ${fatherNameUsed}`;
    if (newName.length > MAX_HOUSEHOLD_NAME_LEN) {
      const truncatedName = newName.slice(0, MAX_HOUSEHOLD_NAME_LEN);
      truncated.push({
        family_id: f.id,
        original: newName,
        truncated: truncatedName,
      });
      newName = truncatedName;
    }

    if (normalizeForCompare(f.household_name) === normalizeForCompare(newName)) {
      skippedAlreadyOk.push({ family_id: f.id, household_name: f.household_name });
      continue;
    }

    toUpdate.push({
      family_id: f.id,
      old_household_name: f.household_name,
      new_household_name: newName,
      father_name_used: fatherNameUsed,
    });
  }

  console.log(`Active families: ${families.length}`);
  console.log(`Will update: ${toUpdate.length}`);
  console.log(`Skip unknown father (unchanged): ${skippedUnknown.length}`);
  console.log(`Skip already correct: ${skippedAlreadyOk.length}`);
  if (truncated.length > 0) {
    console.log(`Truncated to ${MAX_HOUSEHOLD_NAME_LEN} chars: ${truncated.length}`);
  }
  console.log('');

  if (skippedUnknown.length > 0) {
    console.log('Unknown father families (left unchanged):');
    for (const row of skippedUnknown) {
      console.log(`  #${row.family_id} "${row.household_name}"`);
    }
    console.log('');
  }

  let updated = 0;
  if (!DRY_RUN && toUpdate.length > 0) {
    const BATCH = 50;
    for (let i = 0; i < toUpdate.length; i += BATCH) {
      const batch = toUpdate.slice(i, i + BATCH);
      await prisma.$transaction(
        batch.map((row) =>
          prisma.families.update({
            where: { id: row.family_id },
            data: { household_name: row.new_household_name },
          }),
        ),
      );
      updated += batch.length;
      console.log(`Updated ${updated}/${toUpdate.length}...`);
    }
  }

  const applyLogPath = path.join(
    auditDir,
    `family-household-name-father-apply-${DRY_RUN ? 'dryrun-' : ''}${stamp}.json`,
  );
  const applyCsvPath = path.join(
    auditDir,
    `family-household-name-father-apply-${DRY_RUN ? 'dryrun-' : ''}${stamp}.csv`,
  );
  const unknownCsvPath = path.join(
    auditDir,
    `family-household-name-father-apply-skipped-unknown-${stamp}.csv`,
  );

  fs.writeFileSync(
    applyLogPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        dry_run: DRY_RUN,
        totals: {
          active_families: families.length,
          updated: DRY_RUN ? 0 : updated,
          planned_updates: toUpdate.length,
          skipped_unknown: skippedUnknown.length,
          skipped_already_ok: skippedAlreadyOk.length,
          truncated: truncated.length,
        },
        updates: toUpdate,
        skipped_unknown: skippedUnknown,
        truncated,
      },
      null,
      2,
    ),
    'utf8',
  );

  fs.writeFileSync(
    applyCsvPath,
    toCSV(
      [
        'family_id',
        'old_household_name',
        'new_household_name',
        'father_name_used',
      ],
      toUpdate,
    ),
    'utf8',
  );

  fs.writeFileSync(
    unknownCsvPath,
    toCSV(['family_id', 'household_name'], skippedUnknown),
    'utf8',
  );

  console.log('====== DONE ======');
  console.log(
    DRY_RUN
      ? `Dry run complete — would update ${toUpdate.length} families (0 written).`
      : `Updated ${updated} families.`,
  );
  console.log(`Left unchanged (unknown father): ${skippedUnknown.length}`);
  console.log(`Log: ${applyLogPath}`);
  console.log(`CSV: ${applyCsvPath}`);
  console.log(`Unknown skip CSV: ${unknownCsvPath}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Fatal error:', e);
  prisma
    .$disconnect()
    .catch(() => {})
    .finally(() => process.exit(1));
});
