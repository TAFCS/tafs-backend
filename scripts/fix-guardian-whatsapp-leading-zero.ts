/**
 * fix-guardian-whatsapp-leading-zero.ts
 *
 * Finds guardian whatsapp_number values stored like +9203052237744
 * (country code + leading 0 + local digits) and normalizes them to
 * +92XXXXXXXXXX (+92 followed by a 10-digit mobile number, no leading 0).
 *
 * Usage (dry run — default, no writes):
 *   npx ts-node -r tsconfig-paths/register scripts/fix-guardian-whatsapp-leading-zero.ts
 *
 * Apply fixes:
 *   npx ts-node -r tsconfig-paths/register scripts/fix-guardian-whatsapp-leading-zero.ts --apply
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Normalize PK WhatsApp: +92 + 10-digit mobile (starts with 3), strip 0 after country code. */
export function normalizeWhatsapp(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toUpperCase() === 'N/A') return null;

  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('92')) {
    digits = digits.slice(2);
  }

  // Remove leading 0 from national number (+9203... / 03...)
  while (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // Pakistani mobile: 10 digits starting with 3
  if (!/^3\d{9}$/.test(digits)) {
    return null;
  }

  return `+92${digits}`;
}

function isPlus920Pattern(raw: string): boolean {
  return /^\+?92\s*0\d+/.test(raw.trim());
}

async function main() {
  console.log(
    APPLY
      ? '═══ FIX GUARDIAN WHATSAPP (APPLY) ═══\n'
      : '═══ FIX GUARDIAN WHATSAPP (DRY RUN) ═══\n',
  );

  const guardians = await prisma.guardians.findMany({
    where: {
      deleted_at: null,
      whatsapp_number: { not: null },
    },
    select: {
      id: true,
      full_name: true,
      cnic: true,
      whatsapp_number: true,
      primary_phone: true,
    },
    orderBy: { id: 'asc' },
  });

  console.log(`Guardians with a WhatsApp value: ${guardians.length}`);

  const changes: Array<{
    id: number;
    full_name: string;
    cnic: string;
    before: string;
    after: string;
    category: 'plus920' | 'local_0' | 'bare_10' | 'other';
  }> = [];

  const skippedOdd: Array<{
    id: number;
    full_name: string;
    whatsapp: string;
    reason: string;
  }> = [];

  const alreadyOk: string[] = [];

  for (const g of guardians) {
    const before = (g.whatsapp_number || '').trim();
    if (!before) continue;

    if (/^\+923\d{9}$/.test(before)) {
      alreadyOk.push(before);
      continue;
    }

    const after = normalizeWhatsapp(before);
    const looksLikeLeadingZero =
      isPlus920Pattern(before) || /^0?3\d{9}$/.test(before.replace(/\D/g, '').replace(/^92/, ''));

    if (after && after !== before) {
      let category: 'plus920' | 'local_0' | 'bare_10' | 'other' = 'other';
      if (isPlus920Pattern(before)) category = 'plus920';
      else if (/^0\d+/.test(before.replace(/\D/g, ''))) category = 'local_0';
      else if (/^3\d{9}$/.test(before.replace(/\D/g, ''))) category = 'bare_10';

      changes.push({
        id: g.id,
        full_name: g.full_name || '',
        cnic: g.cnic || '',
        before,
        after,
        category,
      });
      continue;
    }

    if (looksLikeLeadingZero || isPlus920Pattern(before)) {
      skippedOdd.push({
        id: g.id,
        full_name: g.full_name || '',
        whatsapp: before,
        reason: after
          ? 'normalize equalled original (unexpected)'
          : 'not a valid PK mobile (need 10 digits starting with 3 after stripping +92/0)',
      });
    }
  }

  const byCat = {
    plus920: changes.filter((c) => c.category === 'plus920'),
    local_0: changes.filter((c) => c.category === 'local_0'),
    bare_10: changes.filter((c) => c.category === 'bare_10'),
    other: changes.filter((c) => c.category === 'other'),
  };

  console.log(`Already correct (+923XXXXXXXXX): ${alreadyOk.length}`);
  console.log(`\nWould fix: ${changes.length}`);
  console.log(`  • +920... (extra 0 after country code): ${byCat.plus920.length}`);
  console.log(`  • 03... local with leading 0:           ${byCat.local_0.length}`);
  console.log(`  • bare 10-digit (3XXXXXXXXX):           ${byCat.bare_10.length}`);
  console.log(`  • other formats:                       ${byCat.other.length}`);

  const printGroup = (title: string, rows: typeof changes) => {
    if (rows.length === 0) return;
    console.log(`\n── ${title} (${rows.length}) ──`);
    console.log('ID      | Before                | After               | Name');
    console.log('-'.repeat(90));
    for (const row of rows) {
      console.log(
        `${String(row.id).padEnd(7)} | ${row.before.padEnd(21)} | ${row.after.padEnd(19)} | ${row.full_name}`,
      );
    }
  };

  printGroup('+920... extra zero after country code', byCat.plus920);
  printGroup('03... local leading zero', byCat.local_0);
  printGroup('Bare 10-digit mobiles', byCat.bare_10);
  printGroup('Other', byCat.other);

  if (skippedOdd.length > 0) {
    console.log(
      `\n⚠️  ${skippedOdd.length} number(s) look wrong but could not be auto-fixed:`,
    );
    for (const row of skippedOdd) {
      console.log(`  #${row.id} ${row.full_name}: "${row.whatsapp}" — ${row.reason}`);
    }
  }

  // Write CSV for review
  const outDir = path.join(__dirname, '..', 'fathers-data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    APPLY
      ? 'guardian-whatsapp-fixed.csv'
      : 'guardian-whatsapp-dry-run.csv',
  );
  const csvLines = [
    'id,full_name,cnic,category,before,after',
    ...changes.map(
      (r) =>
        [
          r.id,
          csvEscape(r.full_name),
          csvEscape(r.cnic),
          r.category,
          csvEscape(r.before),
          csvEscape(r.after),
        ].join(','),
    ),
  ];
  fs.writeFileSync(outPath, csvLines.join('\n') + '\n', 'utf8');
  console.log(`\nCSV written: ${outPath}`);

  if (!APPLY) {
    await dryRunPendingChangeRequests();
    console.log(
      '\nDry run only — no DB writes. Re-run with --apply to update guardians.',
    );
    return;
  }

  let updated = 0;
  for (const row of changes) {
    await prisma.guardians.update({
      where: { id: row.id },
      data: { whatsapp_number: row.after },
    });
    updated++;
  }
  console.log(`\nUpdated ${updated} guardian WhatsApp number(s).`);
}

function csvEscape(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** Also scan pending change requests that still propose a bad whatsapp_number. */
async function dryRunPendingChangeRequests() {
  const pending = await prisma.parent_change_requests.findMany({
    where: { status: 'PENDING' },
    select: {
      id: true,
      guardian_id: true,
      requested_data: true,
      guardians: { select: { full_name: true } },
    },
  });

  const hits: Array<{
    request_id: number;
    guardian_id: number;
    name: string;
    before: string;
    after: string;
  }> = [];

  for (const req of pending) {
    const data = req.requested_data as Record<string, unknown>;
    if (!data || typeof data !== 'object') continue;

    const before = data.whatsapp_number;
    if (typeof before !== 'string' || !before.trim()) continue;

    const after = normalizeWhatsapp(before);
    if (after && after !== before.trim()) {
      hits.push({
        request_id: req.id,
        guardian_id: req.guardian_id,
        name: req.guardians?.full_name || '',
        before: before.trim(),
        after,
      });
    }
  }

  console.log(
    `\n── Pending change requests with fixable whatsapp_number (${hits.length}) ──`,
  );
  if (hits.length === 0) {
    console.log('(none)');
    return;
  }
  for (const h of hits) {
    console.log(
      `  request #${h.request_id} guardian #${h.guardian_id} ${h.name}: ${h.before} → ${h.after}`,
    );
  }
  console.log(
    '  (Not auto-applied — approve/reject flow owns these. Shown for review only.)',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
