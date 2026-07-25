/**
 * DRY RUN ONLY — proposed employee_code renames by campus.
 * Does NOT write to the DB.
 *
 * Proposed rule (from user examples):
 *   Gulistan-e-Johar  → GEJ-{existing}
 *   Kaneez Fatima     → GKF-{existing}
 *   North Nazimabad   → NNN-{existing}
 * e.g. 02-1955 on Johar → GEJ-02-1955
 *
 * Usage: node scripts/dry-run-employee-code-campus-prefix.js
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const PREFIX_BY_CAMPUS_ID = {
  1: 'GEJ', // Gulistan-e-Johar Campus (DB code JHR)
  2: 'GKF', // Kaneez Fatima Campus (DB code KNF)
  3: 'NNN', // North Nazimabad Campus (DB code NNZ)
};

const CODE_OVERRIDES = {
  155: 'GEJ-01-0009', // ASIFA OWAIS
};

const p = new PrismaClient();

function propose(code, campusId, id) {
  if (id && CODE_OVERRIDES[id]) {
    return { status: 'rename', newCode: CODE_OVERRIDES[id] };
  }
  const prefix = PREFIX_BY_CAMPUS_ID[campusId];
  if (!prefix) return { status: 'skip_no_campus', newCode: null };
  if (!code) return { status: 'skip_no_code', newCode: null };
  if (code.startsWith(`${prefix}-`)) return { status: 'already_prefixed', newCode: code };
  // Already has a different letter prefix
  if (/^[A-Za-z]/.test(code)) return { status: 'skip_legacy_prefix', newCode: null };
  return { status: 'rename', newCode: `${prefix}-${code}` };
}

(async () => {
  const employees = await p.employee_profiles.findMany({
    select: {
      id: true,
      employee_code: true,
      employee_code_dep: true,
      employee_code_number: true,
      full_name: true,
      campus_id: true,
      campuses: { select: { campus_name: true, campus_code: true } },
    },
    orderBy: [{ campus_id: 'asc' }, { employee_code: 'asc' }],
  });

  const byCampus = new Map();
  const unassigned = [];
  const collisions = [];
  const proposedCodes = new Map(); // newCode -> [employees]

  for (const e of employees) {
    const campusKey = e.campus_id ?? 'UNASSIGNED';
    if (!byCampus.has(campusKey)) byCampus.set(campusKey, []);
    const proposal = propose(e.employee_code, e.campus_id, e.id);
    const row = {
      id: e.id,
      full_name: e.full_name,
      campus_id: e.campus_id,
      campus_name: e.campuses?.campus_name ?? '(no campus)',
      campus_code_db: e.campuses?.campus_code ?? null,
      prefix: PREFIX_BY_CAMPUS_ID[e.campus_id] ?? null,
      old_code: e.employee_code,
      new_code: proposal.newCode,
      status: proposal.status,
      employee_code_dep: e.employee_code_dep,
      employee_code_number: e.employee_code_number,
    };
    byCampus.get(campusKey).push(row);
    if (campusKey === 'UNASSIGNED') unassigned.push(row);

    if (proposal.status === 'rename' && proposal.newCode) {
      if (!proposedCodes.has(proposal.newCode)) proposedCodes.set(proposal.newCode, []);
      proposedCodes.get(proposal.newCode).push(row);
    }
  }

  for (const [code, rows] of proposedCodes) {
    if (rows.length > 1) collisions.push({ code, count: rows.length, ids: rows.map((r) => r.id) });
  }

  // Also check collisions against codes that won't change (already_prefixed / other campuses)
  const existingKeep = new Set(
    employees
      .filter((e) => {
        const pr = propose(e.employee_code, e.campus_id);
        return pr.status !== 'rename';
      })
      .map((e) => (e.employee_code || '').toUpperCase())
      .filter(Boolean),
  );
  const collideWithExisting = [];
  for (const [code, rows] of proposedCodes) {
    if (existingKeep.has(code.toUpperCase())) {
      collideWithExisting.push({ code, ids: rows.map((r) => r.id) });
    }
  }

  const lines = [];
  lines.push('# Employee code campus-prefix dry run');
  lines.push('');
  lines.push('**No DB writes.** Review this file, then approve before running the rename.');
  lines.push('');
  lines.push('## Proposed rule');
  lines.push('');
  lines.push('| Campus (DB) | DB campus_code | New prefix | Example |');
  lines.push('|---|---|---|---|');
  lines.push('| Gulistan-e-Johar Campus | JHR | **GEJ** | `02-1955` → `GEJ-02-1955` |');
  lines.push('| Kaneez Fatima Campus | KNF | **GKF** | `02-1955` → `GKF-02-1955` |');
  lines.push('| North Nazimabad Campus | NNZ | **NNN** | `02-1955` → `NNN-02-1955` |');
  lines.push('');
  lines.push('## Summary');
  lines.push('');

  let renameTotal = 0;
  let skipTotal = 0;
  for (const [key, rows] of byCampus) {
    const renames = rows.filter((r) => r.status === 'rename').length;
    const skips = rows.length - renames;
    renameTotal += renames;
    skipTotal += skips;
    const label =
      key === 'UNASSIGNED'
        ? 'UNASSIGNED (campus_id null)'
        : `${rows[0].campus_name} (id=${key}, prefix=${rows[0].prefix})`;
    lines.push(`- **${label}**: ${rows.length} employees — ${renames} to rename, ${skips} skipped`);
  }
  lines.push('');
  lines.push(`- **Total to rename:** ${renameTotal}`);
  lines.push(`- **Total skipped:** ${skipTotal}`);
  lines.push(`- **Duplicate proposed codes:** ${collisions.length}`);
  lines.push(`- **Proposed code collides with existing kept code:** ${collideWithExisting.length}`);
  lines.push('');

  if (collisions.length || collideWithExisting.length) {
    lines.push('## ⚠ Collisions (must resolve before apply)');
    lines.push('');
    for (const c of collisions) {
      lines.push(`- Proposed \`${c.code}\` would be used by ${c.count} employees: ids ${c.ids.join(', ')}`);
    }
    for (const c of collideWithExisting) {
      lines.push(`- Proposed \`${c.code}\` already exists on another employee: ids ${c.ids.join(', ')}`);
    }
    lines.push('');
  }

  const order = [1, 2, 3, 'UNASSIGNED'];
  for (const key of order) {
    if (!byCampus.has(key)) continue;
    const rows = byCampus.get(key);
    const title =
      key === 'UNASSIGNED'
        ? 'UNASSIGNED — no campus_id (will NOT be renamed)'
        : `${rows[0].campus_name} — prefix \`${rows[0].prefix}\``;
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| id | full_name | old_code | new_code | status |');
    lines.push('|---:|---|---|---|---|');
    for (const r of rows) {
      lines.push(
        `| ${r.id} | ${r.full_name ?? ''} | \`${r.old_code ?? ''}\` | \`${r.new_code ?? '—'}\` | ${r.status} |`,
      );
    }
    lines.push('');
  }

  const outPath = path.join(__dirname, 'dry-run-employee-code-campus-prefix.md');
  fs.writeFileSync(outPath, lines.join('\n'));

  // Also CSV for easy spreadsheet review
  const csvPath = path.join(__dirname, 'dry-run-employee-code-campus-prefix.csv');
  const csvRows = [
    'campus_id,campus_name,prefix,id,full_name,old_code,new_code,status',
  ];
  for (const key of order) {
    if (!byCampus.has(key)) continue;
    for (const r of byCampus.get(key)) {
      csvRows.push(
        [
          r.campus_id ?? '',
          JSON.stringify(r.campus_name),
          r.prefix ?? '',
          r.id,
          JSON.stringify(r.full_name ?? ''),
          r.old_code ?? '',
          r.new_code ?? '',
          r.status,
        ].join(','),
      );
    }
  }
  fs.writeFileSync(csvPath, csvRows.join('\n'));

  console.log(`Wrote ${outPath}`);
  console.log(`Wrote ${csvPath}`);
  console.log(`Rename: ${renameTotal}, Skip: ${skipTotal}, Collisions: ${collisions.length + collideWithExisting.length}`);

  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
