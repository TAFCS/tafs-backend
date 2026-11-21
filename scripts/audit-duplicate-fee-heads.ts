/**
 * TAFSD-546 audit (read-only). Lists every group of fee heads that look like
 * duplicates, says which are real, and writes the finance review sheet.
 *
 *   npx ts-node scripts/audit-duplicate-fee-heads.ts                 # summary only
 *   npx ts-node scripts/audit-duplicate-fee-heads.ts --out <dir>     # also writes the xlsx
 *
 * Reads whatever DATABASE_URL points at, inside a READ ONLY transaction. Writes
 * nothing to the database. The sheet carries student names, so --out must be a
 * folder outside this repository (it refuses one inside it).
 *
 * Classification rules: src/modules/student-fees/duplicate-fee-heads/classify.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import {
  loadAudit,
  AuditData,
} from '../src/modules/student-fees/duplicate-fee-heads/load';
import {
  GroupResult,
  VERDICT_LABEL,
  Verdict,
  HeadCopy,
} from '../src/modules/student-fees/duplicate-fee-heads/classify';
import { planCleanup } from '../src/modules/student-fees/duplicate-fee-heads/cleanup';

const MONTHS = [
  '',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const VERDICTS: Verdict[] = [
  'LEGIT',
  'DUP_UNBILLED',
  'DUP_ONE_BILLED',
  'DUP_NEEDS_REVERSAL',
  'UNCLEAR',
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** What kind of legitimate group this is, for the summary. */
export function legitKind(g: GroupResult): string {
  if (g.reason.includes('instalment')) return 'instalment plan';
  const split = g.reason.includes('voucher split');
  const months = g.months.length;
  if (split && months > 1) return 'voucher split + several months';
  if (split) return 'voucher split (paid part + balance)';
  if (months >= 12) return 'whole year on one fee date';
  return 'several months on one fee date';
}

function copyLine(c: HeadCopy): string {
  const v = c.vouchers.map((x) => `V${x.id} ${x.status}`).join(', ');
  const d = [
    ...new Set(c.allocations.map((a) => `D${a.deposit_id} Rs ${a.amount}`)),
  ].join(', ');
  return (
    `#${c.id} ${MONTHS[c.target_month]} fee date ${c.fee_date ?? '-'} Rs ${c.amount} paid ${c.amount_paid} ${c.status}` +
    (c.description_prefix
      ? ` [${c.description_prefix}${c.split_pair_id ? ` of #${c.split_pair_id}` : ''}]`
      : '') +
    (c.installment_id ? ` instalment ${c.installment_id}` : '') +
    (v ? `; vouchers ${v}` : '; no voucher') +
    (d ? `; deposits ${d}` : '')
  );
}

function summarise(data: AuditData) {
  const lines: string[] = [];
  for (const kind of ['same_fee_date', 'same_month_other_dates'] as const) {
    const gs = data.groups.filter((g) => g.kind === kind);
    lines.push(
      kind === 'same_fee_date'
        ? `Same student, fee type, fee date and academic year: ${gs.length} groups, ${new Set(gs.map((g) => g.student_id)).size} students`
        : `Same month on different fee dates: ${gs.length} groups, ${new Set(gs.map((g) => g.student_id)).size} students`,
    );
    for (const v of VERDICTS) {
      const n = gs.filter((g) => g.verdict === v);
      if (!n.length) continue;
      lines.push(`  ${VERDICT_LABEL[v]}: ${n.length}`);
      if (v === 'LEGIT') {
        const sub = new Map<string, number>();
        for (const g of n)
          sub.set(legitKind(g), (sub.get(legitKind(g)) ?? 0) + 1);
        for (const [k, c] of [...sub.entries()].sort((a, b) => b[1] - a[1]))
          lines.push(`    ${k}: ${c}`);
      }
    }
    const unpaid = gs.filter((g) => g.has_unpaid_copy);
    lines.push(
      `  with at least one copy not PAID or WAIVED: ${unpaid.length}; with two copies of one month both still owed or to be billed: ${gs.filter((g) => g.billable_twice).length}`,
    );
  }
  return lines;
}

function unpaidBreakdown(data: AuditData) {
  const gs = data.groups.filter(
    (g) => g.kind === 'same_fee_date' && g.has_unpaid_copy,
  );
  const m = new Map<string, number>();
  for (const g of gs) {
    const k =
      g.verdict === 'LEGIT'
        ? `${VERDICT_LABEL.LEGIT}: ${legitKind(g)}`
        : VERDICT_LABEL[g.verdict];
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function writeSheet(data: AuditData, outDir: string) {
  const repo = path.resolve(__dirname, '..');
  const out = path.resolve(outDir);
  if (out === repo || out.startsWith(repo + path.sep)) {
    throw new Error(
      `--out ${out} is inside the repository. The sheet has student names; write it somewhere outside git.`,
    );
  }
  fs.mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(
    out,
    `TAFSD-546-duplicate-fee-heads-review-${stamp}.xlsx`,
  );

  const ft = (id: number | null) =>
    id == null ? '-' : `${data.feeTypes.get(id) ?? '?'} (${id})`;
  const st = (cc: number) => data.students.get(cc);
  const plan = planCleanup(data.groups);

  // Summary
  const summary: (string | number)[][] = [
    ['TAFSD-546: duplicate fee heads, finance review'],
    [
      `Read-only audit of production on ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC. Nothing has been changed.`,
    ],
    [],
    [
      'Group kind',
      'Class',
      'Groups',
      'Students',
      'Has a copy not PAID/WAIVED',
      'Same month owed twice',
    ],
  ];
  for (const kind of ['same_fee_date', 'same_month_other_dates'] as const) {
    const label =
      kind === 'same_fee_date'
        ? 'Same fee date'
        : 'Same month, different fee dates';
    for (const v of VERDICTS) {
      const gs = data.groups.filter((g) => g.kind === kind && g.verdict === v);
      if (!gs.length) continue;
      if (v === 'LEGIT') {
        const sub = new Map<string, GroupResult[]>();
        for (const g of gs)
          sub.set(legitKind(g), [...(sub.get(legitKind(g)) ?? []), g]);
        for (const [k, list] of sub) {
          summary.push([
            label,
            `Legitimate: ${k}`,
            list.length,
            new Set(list.map((g) => g.student_id)).size,
            list.filter((g) => g.has_unpaid_copy).length,
            list.filter((g) => g.billable_twice).length,
          ]);
        }
      } else {
        summary.push([
          label,
          VERDICT_LABEL[v],
          gs.length,
          new Set(gs.map((g) => g.student_id)).size,
          gs.filter((g) => g.has_unpaid_copy).length,
          gs.filter((g) => g.billable_twice).length,
        ]);
      }
    }
    const all = data.groups.filter((g) => g.kind === kind);
    summary.push([
      label,
      'Total',
      all.length,
      new Set(all.map((g) => g.student_id)).size,
      all.filter((g) => g.has_unpaid_copy).length,
      all.filter((g) => g.billable_twice).length,
    ]);
  }
  summary.push(
    [],
    ['What the cleanup script would do (dry run)'],
    ['Unbilled duplicate copies it would delete', plan.removals.length],
    [
      'Rs it would remove from to-be-billed',
      plan.removals.reduce((s, r) => s + r.amount, 0),
    ],
    ['Groups left for a person (reversal or review)', plan.manual.length],
    [],
    ['How to read this'],
    [
      'A voucher split turns one fee head into a paid "PARTIAL PAYMENT OF" row and a "BALANCE PAYMENT OF" row on the same fee date and month. That is one fee, recorded correctly, not a duplicate.',
    ],
    [
      'Several months on one fee date (for example a whole year billed at once) repeat the fee type and fee date but never the month. Also not a duplicate.',
    ],
    [
      'A duplicate is the same month appearing twice as independent heads. None of the same-fee-date groups is one.',
    ],
    [
      '"Same month, different fee dates" groups are a second check the ticket\'s acceptance needs. Each needs a person: the paid copy may simply carry the wrong academic year or month.',
    ],
  );

  // Groups
  const groupRows = data.groups
    .slice()
    .sort(
      (a, b) =>
        VERDICTS.indexOf(b.verdict) - VERDICTS.indexOf(a.verdict) ||
        a.student_id - b.student_id,
    )
    .map((g) => {
      const s = st(g.student_id);
      return {
        'Group kind':
          g.kind === 'same_fee_date'
            ? 'Same fee date'
            : 'Same month, different fee dates',
        Class:
          g.verdict === 'LEGIT'
            ? `Legitimate: ${legitKind(g)}`
            : VERDICT_LABEL[g.verdict],
        'Proposed action': g.action,
        Why: g.reason,
        CC: g.student_id,
        GR: s?.gr_number ?? '',
        Student: s?.full_name ?? '',
        'Student status': s?.status ?? '',
        Campus: s?.campus ?? '',
        'Class / section': [s?.class_name, s?.section]
          .filter(Boolean)
          .join(' '),
        'Fee type': ft(g.fee_type_id),
        'Academic year': g.academic_year,
        'Fee date':
          g.fee_date ??
          [...new Set(g.copies.map((c) => c.fee_date))].sort().join(', '),
        'Month(s)': [...new Set(g.copies.map((c) => c.target_month))]
          .map((m) => MONTHS[m])
          .join(', '),
        Copies: g.copies.length,
        'Total amount': g.copies.reduce((x, c) => x + c.amount, 0),
        'Total paid': g.copies.reduce((x, c) => x + c.amount_paid, 0),
        'Copy not PAID/WAIVED': g.has_unpaid_copy ? 'yes' : '',
        'Same month owed twice': g.billable_twice ? 'YES' : '',
        'Would delete (ids)': g.remove.join(', '),
        'Copies (id, month, fee date, amount, paid, status, vouchers, deposits)':
          g.copies.map(copyLine).join('\n'),
      };
    });

  // Copies
  const copyRows = data.groups.flatMap((g) =>
    g.copies.map((c) => {
      const s = st(g.student_id);
      const month = g.months.find((m) => m.target_month === c.target_month)!;
      const fam = month.families.find((f) => f.rows.includes(c))!;
      const proposed = g.remove.includes(c.id)
        ? 'remove'
        : g.verdict === 'LEGIT'
          ? 'no action'
          : month.keep === fam.root
            ? 'keep'
            : g.verdict === 'UNCLEAR'
              ? 'review'
              : 'reverse, then remove';
      return {
        'Group kind':
          g.kind === 'same_fee_date'
            ? 'Same fee date'
            : 'Same month, different fee dates',
        Class:
          g.verdict === 'LEGIT'
            ? `Legitimate: ${legitKind(g)}`
            : VERDICT_LABEL[g.verdict],
        CC: g.student_id,
        Student: s?.full_name ?? '',
        Campus: s?.campus ?? '',
        'Class / section': [s?.class_name, s?.section]
          .filter(Boolean)
          .join(' '),
        'Fee type': ft(c.fee_type_id),
        'Academic year': c.academic_year,
        'Fee date': c.fee_date ?? '',
        Month: MONTHS[c.target_month],
        'student_fees.id': c.id,
        Amount: c.amount,
        'Amount paid': c.amount_paid,
        Status: c.status,
        'Split prefix': c.description_prefix ?? '',
        'Split of': c.split_pair_id ?? '',
        'Counted as copy': fam.root,
        Instalment: c.installment_id ?? '',
        Vouchers: c.vouchers
          .map(
            (v) =>
              `${v.id} (${v.status}${v.voucher_number ? `, ${v.voucher_number}` : ''})`,
          )
          .join(', '),
        Deposits: [
          ...new Map(c.allocations.map((a) => [a.deposit_id, a])).values(),
        ]
          .map(
            (a) => `D${a.deposit_id} on ${a.deposit_date?.slice(0, 10) ?? '-'}`,
          )
          .join(', '),
        'Allocated Rs': c.allocations.reduce((x, a) => x + a.amount, 0),
        Proposed: proposed,
      };
    }),
  );

  const wb = XLSX.utils.book_new();
  const sSummary = XLSX.utils.aoa_to_sheet(summary);
  sSummary['!cols'] = [
    { wch: 34 },
    { wch: 48 },
    { wch: 10 },
    { wch: 10 },
    { wch: 26 },
    { wch: 22 },
  ];
  XLSX.utils.book_append_sheet(wb, sSummary, 'Summary');
  const sGroups = XLSX.utils.json_to_sheet(groupRows);
  sGroups['!cols'] = [
    18, 40, 70, 50, 7, 10, 26, 12, 22, 18, 30, 11, 22, 18, 7, 12, 10, 10, 10,
    12, 110,
  ].map((wch) => ({ wch }));
  sGroups['!autofilter'] = { ref: sGroups['!ref']! };
  XLSX.utils.book_append_sheet(wb, sGroups, 'Groups');
  const sCopies = XLSX.utils.json_to_sheet(copyRows);
  sCopies['!autofilter'] = { ref: sCopies['!ref']! };
  sCopies['!cols'] = [
    18, 40, 7, 26, 22, 18, 30, 11, 11, 6, 10, 9, 10, 13, 20, 8, 10, 9, 30, 30,
    10, 18,
  ].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, sCopies, 'Copies');
  XLSX.writeFile(wb, file, { compression: true });
  return file;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const data = await loadAudit(prisma);
    for (const l of summarise(data)) console.log(l);
    console.log(
      '\nSame-fee-date groups with a copy not PAID or WAIVED, by class:',
    );
    for (const [k, n] of unpaidBreakdown(data)) console.log(`  ${k}: ${n}`);
    const dups = data.groups.filter((g) => g.verdict !== 'LEGIT');
    if (dups.length) {
      console.log('\nGroups that need attention:');
      for (const g of dups)
        console.log(
          `  CC ${g.student_id} ${g.key} ${VERDICT_LABEL[g.verdict]}: ${g.reason}. ${g.action}`,
        );
    }
    const out = arg('--out');
    if (out) console.log(`\nWrote ${writeSheet(data, out)}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
