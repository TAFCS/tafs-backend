// Fee Endowment / Complementary: clear every flag, then set the students from
// fee-exemption-check-2026-27.xlsx whose fee check found no contradiction.
// Dry run by default. --apply writes, in one transaction.
//
// Usage (from tafs-backend/):
//   set -a; . ./.env; set +a
//   node scripts/fecomp-reset-and-backfill.js ../fee-exemption-check-2026-27.xlsx          # dry run
//   node scripts/fecomp-reset-and-backfill.js ../fee-exemption-check-2026-27.xlsx --apply  # write
//
// Before writing it saves every student it will touch (old values) to
// ../fecomp-backup-<timestamp>.csv, so the change can be undone.
const { PrismaClient } = require('@prisma/client');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const file =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  path.resolve(__dirname, '../../fee-exemption-check-2026-27.xlsx');

// Only these two exist in the database today. Fee Endowment MTF, Sehm-e-Sadaat
// and Sehm-e-Imam wait for their own fields.
const CATS = {
  'Fee Endowment': { flag: 'is_fee_endowment', reason: 'fee_endowment_reason', until: 'fee_endowment_until' },
  Complementary: { flag: 'is_complementary', reason: 'complementary_reason', until: 'complementary_until' },
};
const FIELDS = [
  'is_fee_endowment', 'fee_endowment_reason', 'fee_endowment_until',
  'is_complementary', 'complementary_reason', 'complementary_until',
];

const v = (x) =>
  x == null ? '' : String(typeof x === 'object' ? (x.result ?? x.text ?? '') : x).trim();
const csv = (x) => {
  const s = x == null ? '' : x instanceof Date ? x.toISOString().slice(0, 10) : String(x);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  // Fee check: system C.C. → OK / CONTRADICTION
  const verdict = new Map();
  wb.getWorksheet('Fee check').eachRow((r, i) => {
    if (i > 1) verdict.set(Number(v(r.values[2])), v(r.values[8]));
  });

  const toSet = [];
  const held = { contradiction: [], newCategory: [], skipped: [] };
  wb.getWorksheet('Backfill plan').eachRow((r, i) => {
    if (i < 2) return;
    const x = r.values.map(v);
    const row = { cc: Number(x[7]), name: x[8], cls: x[9], category: x[11], reason: x[12], until: x[13], action: x[17] };
    const res = verdict.get(row.cc);
    if (!res) throw new Error(`No fee check result for C.C. ${row.cc} ${row.name}`);
    if (res === 'CONTRADICTION') held.contradiction.push(row);
    else if (row.action !== 'SET') held.skipped.push(row);
    else if (!CATS[row.category]) held.newCategory.push(row);
    else toSet.push(row);
  });

  const ccs = toSet.map((s) => s.cc);
  if (new Set(ccs).size !== ccs.length) throw new Error('Duplicate C.C. in the set list');

  const prisma = new PrismaClient();
  try {
    const select = { cc: true, full_name: true, status: true, ...Object.fromEntries(FIELDS.map((f) => [f, true])) };
    const flagged = await prisma.students.findMany({
      where: {
        OR: [
          { is_fee_endowment: true }, { is_complementary: true },
          { fee_endowment_reason: { not: null } }, { fee_endowment_until: { not: null } },
          { complementary_reason: { not: null } }, { complementary_until: { not: null } },
        ],
      },
      select,
    });
    const targets = await prisma.students.findMany({ where: { cc: { in: ccs } }, select });
    const found = new Map(targets.map((t) => [t.cc, t]));
    const missing = toSet.filter((s) => !found.has(s.cc));
    if (missing.length) throw new Error(`Not in database: ${missing.map((m) => m.cc).join(', ')}`);
    for (const s of toSet) {
      const db = found.get(s.cc);
      if (db.full_name?.trim().toUpperCase() !== s.name.toUpperCase())
        console.log(`  note: C.C. ${s.cc} name in system is "${db.full_name}", plan says "${s.name}"`);
    }

    const setCcs = new Set(ccs);
    const clearedOnly = flagged.filter((f) => !setCcs.has(f.cc));
    const count = (cat) => toSet.filter((s) => s.category === cat).length;

    console.log(`Currently flagged in the system: ${flagged.length} students. All will be cleared.`);
    console.log(`Then set: ${toSet.length} (Fee Endowment ${count('Fee Endowment')}, Complementary ${count('Complementary')})`);
    console.log(`Cleared and left empty: ${clearedOnly.length}`);
    for (const f of clearedOnly)
      console.log(`  ${f.cc}  ${f.full_name}  [${f.status}]  was ${f.is_fee_endowment ? 'Fee Endowment' : ''}${f.is_complementary ? ' Complementary' : ''}`);
    console.log(`Held for later: ${held.contradiction.length} with contradictions, ${held.newCategory.length} needing a new category (${[...new Set(held.newCategory.map((h) => h.category))].join(', ')}), ${held.skipped.length} skipped`);
    for (const h of held.skipped) console.log(`  skipped: ${h.cc} ${h.name}`);

    if (!APPLY) {
      console.log('\nDry run, nothing written. Re-run with --apply to write.');
      return;
    }

    const touched = new Map([...flagged, ...targets].map((s) => [s.cc, s]));
    const backup = path.resolve(path.dirname(file), `fecomp-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
    fs.writeFileSync(
      backup,
      ['cc,full_name,status,' + FIELDS.join(',')]
        .concat([...touched.values()].map((s) => [s.cc, s.full_name, s.status, ...FIELDS.map((f) => s[f])].map(csv).join(',')))
        .join('\n') + '\n',
    );
    console.log(`\nBackup of ${touched.size} students saved to ${backup}`);

    await prisma.$transaction(async (tx) => {
      const cleared = await tx.students.updateMany({
        where: { cc: { in: flagged.map((f) => f.cc) } },
        data: {
          is_fee_endowment: false, fee_endowment_reason: null, fee_endowment_until: null,
          is_complementary: false, complementary_reason: null, complementary_until: null,
        },
      });
      console.log(`Cleared ${cleared.count}`);
      for (const s of toSet) {
        const c = CATS[s.category];
        await tx.students.update({
          where: { cc: s.cc },
          data: { [c.flag]: true, [c.reason]: s.reason || null, [c.until]: new Date(`${s.until}T00:00:00Z`) },
        });
      }
      console.log(`Set ${toSet.length}`);
    }, { timeout: 120000 });
    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
