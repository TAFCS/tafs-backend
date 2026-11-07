// TAFSD-455: after the new categories exist, set every student from
// fee-exemption-check-2026-27.xlsx whose fee check found no contradiction,
// in their category (Fee Endowment, Fee Endowment (Monthly Tuition Fee),
// Complementary, Sehm-e-Sadaat, Sehm-e-Imam), with the reason, end date and
// reminder date from the plan. Adds only: never clears another student.
// Re-running is safe. Dry run by default; --apply writes in one transaction.
//
// Usage (from tafs-backend/, .env loaded):
//   node scripts/fecomp-backfill-categories.js            # dry run
//   node scripts/fecomp-backfill-categories.js --apply    # write
const { PrismaClient } = require('@prisma/client');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const file =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  path.resolve(__dirname, '../../fee-exemption-check-2026-27.xlsx');

const PREFIX = {
  'Fee Endowment': 'fee_endowment',
  'Fee Endowment MTF': 'fee_endowment_mtf',
  Complementary: 'complementary',
  'Sehm-e-Sadaat': 'sehm_e_sadaat',
  'Sehm-e-Imam': 'sehm_e_imam',
};
const ALL = Object.values(PREFIX).flatMap((p) => [`is_${p}`, `${p}_reason`, `${p}_until`, `${p}_remind_from`]);

const v = (x) => (x == null ? '' : String(typeof x === 'object' ? (x.result ?? x.text ?? '') : x).trim());
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const csv = (x) => {
  const s = x == null ? '' : x instanceof Date ? day(x) : String(x);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const verdict = new Map();
  wb.getWorksheet('Fee check').eachRow((r, i) => {
    if (i > 1) verdict.set(Number(v(r.values[2])), v(r.values[8]));
  });
  const rows = [];
  wb.getWorksheet('Backfill plan').eachRow((r, i) => {
    if (i < 2) return;
    const x = r.values.map(v);
    const row = { cc: Number(x[7]), name: x[8], category: x[11], reason: x[12], until: x[13], remind: x[14], action: x[17] };
    if (verdict.get(row.cc) === 'CONTRADICTION' || row.action !== 'SET') return;
    if (!PREFIX[row.category]) throw new Error(`Unknown category "${row.category}" for C.C. ${row.cc}`);
    rows.push(row);
  });

  const prisma = new PrismaClient();
  try {
    const select = { cc: true, full_name: true, ...Object.fromEntries(ALL.map((f) => [f, true])) };
    const db = new Map(
      (await prisma.students.findMany({ where: { cc: { in: rows.map((r) => r.cc) } }, select })).map((s) => [s.cc, s]),
    );
    const missing = rows.filter((r) => !db.has(r.cc));
    if (missing.length) throw new Error(`Not in database: ${missing.map((m) => m.cc).join(', ')}`);

    const counts = {};
    const changes = [];
    for (const r of rows) {
      const p = PREFIX[r.category];
      const s = db.get(r.cc);
      const want = { [`is_${p}`]: true, [`${p}_reason`]: r.reason || null, [`${p}_until`]: r.until, [`${p}_remind_from`]: r.remind };
      const differs =
        !s[`is_${p}`] || (s[`${p}_reason`] ?? null) !== want[`${p}_reason`] ||
        day(s[`${p}_until`]) !== r.until || day(s[`${p}_remind_from`]) !== r.remind;
      counts[r.category] = (counts[r.category] ?? 0) + 1;
      if (differs) changes.push({ r, p, s });
    }
    console.log(`Clean students on the list: ${rows.length}`, counts);
    console.log(`To write: ${changes.length} (the rest already match)`);
    const fresh = changes.filter((c) => !c.s[`is_${c.p}`]);
    console.log(`Newly switched on: ${fresh.length}`);
    for (const c of fresh) console.log(`  ${c.r.cc}  ${c.s.full_name}  → ${c.r.category}  until ${c.r.until}, remind from ${c.r.remind}`);

    if (!APPLY) {
      console.log('\nDry run, nothing written. Re-run with --apply to write.');
      return;
    }
    const backup = path.resolve(path.dirname(file), `fecomp-categories-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
    fs.writeFileSync(
      backup,
      ['cc,full_name,' + ALL.join(',')]
        .concat(changes.map(({ s }) => [s.cc, s.full_name, ...ALL.map((f) => s[f])].map(csv).join(',')))
        .join('\n') + '\n',
    );
    console.log(`\nBackup of ${changes.length} students saved to ${backup}`);
    await prisma.$transaction(async (tx) => {
      for (const { r, p } of changes)
        await tx.students.update({
          where: { cc: r.cc },
          data: {
            [`is_${p}`]: true,
            [`${p}_reason`]: r.reason || null,
            [`${p}_until`]: new Date(`${r.until}T00:00:00Z`),
            [`${p}_remind_from`]: new Date(`${r.remind}T00:00:00Z`),
          },
        });
    }, { timeout: 120000 });
    console.log(`Wrote ${changes.length}. Done.`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
