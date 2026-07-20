/**
 * report-family-household-name-changes.ts
 *
 * Generates a report of how many families would change their household_name if we
 * rename to:
 *   "FAMILY OF (father's name)"
 *
 * Rules:
 * - Father name is resolved from guardian links where relationship includes "Father"
 *   (case-insensitive), using the guardians.full_name.
 * - For each family we choose the most common father full_name across its students.
 * - If no father name can be resolved for a family:
 *     - household_name stays unchanged
 *     - the family is counted under "unknown"
 *
 * This is a read-only script (no DB writes).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/report-family-household-name-changes.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

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

  const families = await prisma.families.findMany({
    where: { deleted_at: null },
    select: { id: true, household_name: true, deleted_at: true },
  });

  console.log(`Active families: ${families.length}`);

  // Fetch father full names via guardian links for all students.
  // We intentionally keep this broad and then attribute to family_id in JS.
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

  let unknownFamiliesCount = 0;
  let changedFamiliesCount = 0;

  const changedFamilyRecords: Array<{
    family_id: number;
    old_household_name: string;
    proposed_household_name: string;
    father_name_used: string;
    father_name_variants: string;
    is_changed: boolean;
  }> = [];

  const unknownByOldName = new Map<string, number>();
  const changedByOldName = new Map<string, Map<string, number>>();

  for (const f of families) {
    const oldName = f.household_name;
    const counts = familyFatherCounts.get(f.id);

    if (!counts || counts.size === 0) {
      unknownFamiliesCount += 1;
      unknownByOldName.set(oldName, (unknownByOldName.get(oldName) ?? 0) + 1);
      continue;
    }

    const variants = [...counts.entries()].map(([name, count]) => ({
      name,
      count,
    }));
    variants.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });

    const fatherNameUsed = variants[0].name;
    const proposedName = `FAMILY OF ${fatherNameUsed}`;

    const isChanged =
      normalizeForCompare(oldName) !== normalizeForCompare(proposedName);

    if (isChanged) {
      changedFamiliesCount += 1;

      const variantsStr = variants
        .map((v) => (v.name === fatherNameUsed ? `${v.name}` : `${v.name}`))
        .join(' | ');

      changedFamilyRecords.push({
        family_id: f.id,
        old_household_name: oldName,
        proposed_household_name: proposedName,
        father_name_used: fatherNameUsed,
        father_name_variants: variantsStr,
        is_changed: true,
      });

      if (!changedByOldName.has(oldName)) changedByOldName.set(oldName, new Map());
      const proposedMap = changedByOldName.get(oldName)!;
      proposedMap.set(proposedName, (proposedMap.get(proposedName) ?? 0) + 1);
    }
  }

  // Build summaries
  const changedHouseholdNameSummary = [...changedByOldName.entries()]
    .map(([oldName, proposedMap]) => {
      const familiesCount = [...proposedMap.values()].reduce((a, b) => a + b, 0);
      const proposedNames = [...proposedMap.keys()].sort((a, b) => a.localeCompare(b));
      return {
        old_household_name: oldName,
        families_count: familiesCount,
        proposed_household_names: proposedNames.join(' | '),
      };
    })
    .sort((a, b) => b.families_count - a.families_count);

  const unknownHouseholdNameSummary = [...unknownByOldName.entries()]
    .map(([oldName, count]) => ({
      old_household_name: oldName,
      families_count: count,
    }))
    .sort((a, b) => b.families_count - a.families_count);

  const reportJsonPath = path.join(
    auditDir,
    `family-household-name-father-report-${stamp}.json`,
  );
  const reportCsvChangedPath = path.join(
    auditDir,
    `family-household-name-father-report-changed-${stamp}.csv`,
  );
  const reportCsvChangedSummaryPath = path.join(
    auditDir,
    `family-household-name-father-report-changed-summary-${stamp}.csv`,
  );
  const reportCsvUnknownSummaryPath = path.join(
    auditDir,
    `family-household-name-father-report-unknown-summary-${stamp}.csv`,
  );

  fs.writeFileSync(
    reportJsonPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        totals: {
          active_families: families.length,
          unknown_families: unknownFamiliesCount,
          changed_families: changedFamiliesCount,
        },
        changed_family_records: changedFamilyRecords,
        changed_household_name_summary: changedHouseholdNameSummary,
        unknown_household_name_summary: unknownHouseholdNameSummary,
      },
      null,
      2,
    ),
    'utf8',
  );

  fs.writeFileSync(
    reportCsvChangedPath,
    toCSV(
      [
        'family_id',
        'old_household_name',
        'proposed_household_name',
        'father_name_used',
        'father_name_variants',
        'is_changed',
      ],
      changedFamilyRecords,
    ),
    'utf8',
  );

  fs.writeFileSync(
    reportCsvChangedSummaryPath,
    toCSV(
      ['old_household_name', 'families_count', 'proposed_household_names'],
      changedHouseholdNameSummary,
    ),
    'utf8',
  );

  fs.writeFileSync(
    reportCsvUnknownSummaryPath,
    toCSV(
      ['old_household_name', 'families_count'],
      unknownHouseholdNameSummary,
    ),
    'utf8',
  );

  console.log('');
  console.log('====== REPORT ======');
  console.log(`Changed families: ${changedFamiliesCount}`);
  console.log(`Unknown father families (unchanged): ${unknownFamiliesCount}`);

  console.log('');
  console.log('Changed household names (top 25):');
  for (const row of changedHouseholdNameSummary.slice(0, 25)) {
    console.log(`- ${row.old_household_name}: ${row.families_count} → ${row.proposed_household_names}`);
  }

  console.log('');
  console.log('Unknown household names (top 25):');
  for (const row of unknownHouseholdNameSummary.slice(0, 25)) {
    console.log(`- ${row.old_household_name}: ${row.families_count}`);
  }

  console.log('');
  console.log('Files written:');
  console.log(`- ${reportJsonPath}`);
  console.log(`- ${reportCsvChangedPath}`);
  console.log(`- ${reportCsvChangedSummaryPath}`);
  console.log(`- ${reportCsvUnknownSummaryPath}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Fatal error:', e);
  prisma
    .$disconnect()
    .catch(() => {})
    .finally(() => process.exit(1));
});

