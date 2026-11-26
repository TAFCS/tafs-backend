/**
 * TAFSD-581 audit (read-only). Two lists for finance, written to one .xlsx.
 *
 * 1. "Whole-year groups": every student whose fee heads of one fee type cover
 *    MIN_MONTHS or more target months on a single fee_date. computeArrears, the
 *    defaulters report and the arrear surcharge treat every such month as owed
 *    once that fee_date passes, so an unpaid group shows the student N months
 *    behind at once. Each row says how the heads got onto one date (a fee
 *    schedule bulk save that re-dated them, per the audit log, or written that
 *    way when created), whether an advance-payment discount came with them,
 *    and what is paid.
 *
 * 2. "Discount paid in cash": every live or paid voucher carrying a discount
 *    that was never used, with the deposits on it. Until TAFSD-581 an EXPIRED
 *    voucher reached the deposit page with no net total, so the page asked for
 *    the gross amount and the discount stayed unused (voucher 14176: challan
 *    Rs 233,943 after due, Rs 273,599 recorded). A PAID row here recorded the
 *    discount as cash; an EXPIRED row is still exposed until the fix ships.
 *
 * Run: npx ts-node scripts/audit-whole-year-one-fee-date.ts [out.xlsx]
 * Default output: ../TAFSD-581/whole-year-fee-date-audit-<date>.xlsx (outside
 * the repo: the sheet has student names). Writes nothing to the database;
 * reads whatever DATABASE_URL points at, inside a read-only transaction.
 */
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';

const MIN_MONTHS = 6;
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const prisma = new PrismaClient();
const n = (v: unknown) => Number(v ?? 0);
const d = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : '');

/** "Aug 26 - Jul 27" style label for an academic year's target months, in term order. */
function monthsLabel(targetMonths: number[], academicYear: string, termStart: number): string {
  const startYear = Number(academicYear.slice(0, 4));
  const slot = (m: number) => (m - termStart + 12) % 12;
  const sorted = [...new Set(targetMonths)].sort((a, b) => slot(a) - slot(b));
  const yy = (m: number) => String((m >= termStart ? startYear : startYear + 1) % 100).padStart(2, '0');
  const runs: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && slot(sorted[j + 1]) === slot(sorted[j]) + 1) j++;
    const a = `${MONTHS[sorted[i]]} ${yy(sorted[i])}`;
    const b = `${MONTHS[sorted[j]]} ${yy(sorted[j])}`;
    runs.push(i === j ? a : `${a} - ${b}`);
    i = j + 1;
  }
  return runs.join(', ');
}

async function main() {
  const out =
    process.argv[2] ??
    path.resolve(__dirname, '../../TAFSD-581', `whole-year-fee-date-audit-${d(new Date())}.xlsx`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const { groups, heads, logs, discounts, vouchers, deposits, risky } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');

      const groups = await tx.$queryRaw<any[]>`
        SELECT sf.student_id, sf.fee_type_id, ft.description AS fee_type, sf.academic_year, sf.fee_date,
               COUNT(DISTINCT sf.target_month)::int AS months
          FROM student_fees sf
          LEFT JOIN fee_types ft ON ft.id = sf.fee_type_id
         WHERE NOT sf.is_discount AND NOT sf.is_arrear_surcharge AND sf.fee_date IS NOT NULL
         GROUP BY 1, 2, 3, 4, 5
        HAVING COUNT(DISTINCT sf.target_month) >= ${MIN_MONTHS}
         ORDER BY sf.fee_date, sf.student_id`;
      const ccs = [...new Set(groups.map((g) => g.student_id as number))];

      const heads = ccs.length
        ? await tx.$queryRaw<any[]>`
        SELECT sf.id, sf.student_id, sf.fee_type_id, sf.academic_year, sf.fee_date, sf.target_month,
               sf.amount, sf.amount_paid, sf.status::text AS status, COALESCE(sf.term_start_month, c.term_start_month, 8) AS term_start,
               s.full_name, s.gr_number, s.status::text AS student_status, cp.campus_name, c.description AS class_name, sec.description AS section
          FROM student_fees sf
          JOIN students s ON s.cc = sf.student_id
          LEFT JOIN campuses cp ON cp.id = s.campus_id
          LEFT JOIN classes c ON c.id = s.class_id
          LEFT JOIN sections sec ON sec.id = s.section_id
         WHERE sf.student_id = ANY(${ccs}) AND NOT sf.is_discount AND NOT sf.is_arrear_surcharge`
        : [];

      const logs = ccs.length
        ? await tx.$queryRaw<any[]>`
        SELECT student_id, changed_at, changed_by, note FROM audit_logs
         WHERE student_id = ANY(${ccs}) AND entity_type = 'STUDENT_FEE_SCHEDULE' AND note LIKE '%date % → %'
         ORDER BY changed_at`
        : [];

      const discounts = ccs.length
        ? await tx.$queryRaw<any[]>`
        SELECT d.student_id, d.academic_year, COALESCE(dp.title, 'Discount') AS title, d.amount, d.amount_paid
          FROM student_fees d LEFT JOIN discount_presets dp ON dp.id = d.discount_type_id
         WHERE d.student_id = ANY(${ccs}) AND d.is_discount`
        : [];

      const vouchers = ccs.length
        ? await tx.$queryRaw<any[]>`
        SELECT vh.student_fee_id, v.id, v.status
          FROM voucher_heads vh JOIN vouchers v ON v.id = vh.voucher_id
         WHERE v.student_id = ANY(${ccs})`
        : [];

      const deposits = ccs.length
        ? await tx.$queryRaw<any[]>`
        SELECT DISTINCT a.student_fee_id, dp.id, dp.created_at, dp.total_amount
          FROM deposit_allocations a JOIN deposits dp ON dp.id = a.deposit_id
         WHERE dp.student_id = ANY(${ccs}) AND a.student_fee_id IS NOT NULL`
        : [];

      const risky = await tx.$queryRaw<any[]>`
        SELECT v.id AS voucher_id, v.student_id, s.full_name, s.gr_number, cp.campus_name, v.status, v.fee_date,
               v.due_date, v.validity_date, v.total_payable_before_due, v.total_payable_after_due,
               COALESCE(dp.title, 'Discount') AS discount_title, sf.amount AS discount, sf.amount_paid AS discount_used,
               (SELECT COALESCE(SUM(h.balance), 0) FROM voucher_heads h JOIN student_fees f ON f.id = h.student_fee_id
                 WHERE h.voucher_id = v.id AND NOT f.is_discount) AS heads_open,
               (SELECT json_agg(json_build_object(
                         'id', x.id, 'at', x.created_at, 'amount', x.total_amount,
                         'by', (SELECT al.changed_by FROM audit_logs al
                                 WHERE al.entity_type = 'DEPOSIT' AND al.entity_id = x.id::text AND al.action = 'CREATED' LIMIT 1))
                       ORDER BY x.id)
                  FROM deposits x
                 WHERE x.id IN (SELECT a.deposit_id FROM deposit_allocations a WHERE a.voucher_id = v.id)) AS deposits
          FROM vouchers v
          JOIN voucher_heads vh ON vh.voucher_id = v.id
          JOIN student_fees sf ON sf.id = vh.student_fee_id AND sf.is_discount
          LEFT JOIN discount_presets dp ON dp.id = sf.discount_type_id
          JOIN students s ON s.cc = v.student_id
          LEFT JOIN campuses cp ON cp.id = s.campus_id
         WHERE sf.amount_paid < sf.amount AND v.status <> 'VOID'
         ORDER BY v.status DESC, v.id`;

      return { groups, heads, logs, discounts, vouchers, deposits, risky };
    },
    { timeout: 60000 },
  );

  const wb = new ExcelJS.Workbook();
  const today = d(new Date());

  // ── Sheet 1 ────────────────────────────────────────────────────────────────
  const s1 = wb.addWorksheet('Whole-year groups', { views: [{ state: 'frozen', ySplit: 1 }] });
  s1.columns = [
    { header: 'CC', key: 'cc', width: 7 },
    { header: 'GR', key: 'gr', width: 7 },
    { header: 'Student', key: 'name', width: 28 },
    { header: 'Student status', key: 'sstatus', width: 12 },
    { header: 'Campus', key: 'campus', width: 22 },
    { header: 'Class', key: 'cls', width: 10 },
    { header: 'Section', key: 'sec', width: 8 },
    { header: 'Fee type', key: 'ft', width: 22 },
    { header: 'Academic year', key: 'ay', width: 11 },
    { header: 'Fee date', key: 'fd', width: 11 },
    { header: 'Months on this date', key: 'nm', width: 9 },
    { header: 'Months', key: 'months', width: 20 },
    { header: 'Amount', key: 'amt', width: 11 },
    { header: 'Paid', key: 'paid', width: 11 },
    { header: 'Outstanding', key: 'out', width: 11 },
    { header: 'State', key: 'state', width: 10 },
    { header: 'Unpaid months not yet due', key: 'future', width: 12 },
    { header: 'Discounts this year (amount / used)', key: 'disc', width: 44 },
    { header: 'How the heads got onto one date', key: 'how', width: 50 },
    { header: 'Vouchers holding them', key: 'vouchers', width: 22 },
    { header: 'Deposits on them', key: 'deps', width: 34 },
  ];

  const thisMonthIdx = new Date().getUTCFullYear() * 12 + new Date().getUTCMonth();
  for (const g of groups) {
    const hs = heads.filter(
      (h) => h.student_id === g.student_id && h.fee_type_id === g.fee_type_id &&
        h.academic_year === g.academic_year && d(h.fee_date) === d(g.fee_date),
    );
    const first = hs[0];
    const termStart = n(first?.term_start) || 8;
    const startYear = Number(String(g.academic_year).slice(0, 4));
    const amt = hs.reduce((s, h) => s + n(h.amount), 0);
    const paid = hs.reduce((s, h) => s + Math.min(n(h.amount_paid), n(h.amount)), 0);
    const out = amt - paid;
    const future = hs.filter((h) => {
      const tm = n(h.target_month);
      const year = tm >= termStart ? startYear : startYear + 1;
      return year * 12 + (tm - 1) > thisMonthIdx && n(h.amount) > n(h.amount_paid);
    });
    const ids = new Set(hs.map((h) => h.id));
    const fdLabel = new Date(g.fee_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const redates = logs.filter((l) => l.student_id === g.student_id && String(l.note).includes(`→ ${fdLabel}`));
    const how = redates.length
      ? `Re-dated to ${d(g.fee_date)} on the student's fee schedule (bulk save) by ${redates[0].changed_by} on ${d(redates[0].changed_at)}` +
        (redates.length > 1 ? ` (${redates.length} saves)` : '')
      : 'No re-date in the audit log: written on this date when the heads were created';
    const disc = discounts
      .filter((x) => x.student_id === g.student_id && x.academic_year === g.academic_year)
      .map((x) => `${x.title}: ${n(x.amount).toLocaleString()} / ${n(x.amount_paid).toLocaleString()}`)
      .join('; ');
    const vs = [...new Map(vouchers.filter((v) => ids.has(v.student_fee_id)).map((v) => [v.id, `${v.id} ${v.status}`])).values()];
    const ds = [...new Map(deposits.filter((x) => ids.has(x.student_fee_id)).map((x) => [x.id, `${x.id}: ${n(x.total_amount).toLocaleString()} on ${d(x.created_at)}`])).values()];

    s1.addRow({
      cc: g.student_id,
      gr: first?.gr_number ?? '',
      name: first?.full_name ?? '',
      sstatus: first?.student_status ?? '',
      campus: first?.campus_name ?? '',
      cls: first?.class_name ?? '',
      sec: first?.section ?? '',
      ft: g.fee_type,
      ay: g.academic_year,
      fd: d(g.fee_date),
      nm: g.months,
      months: monthsLabel(hs.map((h) => n(h.target_month)), g.academic_year, termStart),
      amt,
      paid,
      out,
      state: out <= 0 ? 'Paid' : paid > 0 ? 'Part paid' : 'Unpaid',
      future: future.length ? `${future.length} (${future.reduce((s, h) => s + n(h.amount) - n(h.amount_paid), 0).toLocaleString()})` : '',
      disc,
      how,
      vouchers: vs.join(', '),
      deps: ds.join('; '),
    });
  }

  // ── Sheet 2 ────────────────────────────────────────────────────────────────
  const s2 = wb.addWorksheet('Discount paid in cash', { views: [{ state: 'frozen', ySplit: 1 }] });
  s2.columns = [
    { header: 'Voucher', key: 'v', width: 8 },
    { header: 'CC', key: 'cc', width: 7 },
    { header: 'GR', key: 'gr', width: 7 },
    { header: 'Student', key: 'name', width: 28 },
    { header: 'Campus', key: 'campus', width: 22 },
    { header: 'Voucher status', key: 'status', width: 10 },
    { header: 'Fee date', key: 'fd', width: 11 },
    { header: 'Due', key: 'due', width: 11 },
    { header: 'Valid to', key: 'valid', width: 11 },
    { header: 'Discount', key: 'dt', width: 30 },
    { header: 'Discount amount', key: 'da', width: 10 },
    { header: 'Discount used', key: 'du', width: 9 },
    { header: 'Challan before due', key: 'before', width: 11 },
    { header: 'Challan after due', key: 'after', width: 11 },
    { header: 'Recorded deposits', key: 'deps', width: 44 },
    { header: 'Recorded total', key: 'rec', width: 11 },
    { header: 'Recorded − challan after due', key: 'diff', width: 12 },
    { header: 'Paid after validity date', key: 'late', width: 9 },
    { header: 'What it means', key: 'means', width: 60 },
  ];
  for (const r of risky) {
    const deps: any[] = r.deposits ?? [];
    const rec = deps.reduce((s, x) => s + n(x.amount), 0);
    const after = n(r.total_payable_after_due);
    const late = deps.length > 0 && deps.every((x) => d(x.at) > d(r.validity_date));
    s2.addRow({
      v: r.voucher_id,
      cc: r.student_id,
      gr: r.gr_number,
      name: r.full_name,
      campus: r.campus_name,
      status: r.status,
      fd: d(r.fee_date),
      due: d(r.due_date),
      valid: d(r.validity_date),
      dt: r.discount_title,
      da: n(r.discount),
      du: n(r.discount_used),
      before: n(r.total_payable_before_due),
      after,
      deps: deps.map((x) => `#${x.id} ${n(x.amount).toLocaleString()} on ${d(x.at)} by ${x.by ?? '?'}`).join('; '),
      rec: deps.length ? rec : '',
      diff: deps.length ? rec - after : '',
      late: deps.length ? (late ? 'yes' : 'no') : '',
      means:
        r.status === 'PAID'
          ? 'The heads were paid at full value and the discount stayed unused. Check the bank record: if the family paid the challan amount, the deposit overstates cash by the discount; if they paid the full amount because the discount was forfeited, the discount row should be removed.'
          : n(r.heads_open) > 0
            ? 'Not paid yet. Until TAFSD-581 ships, the deposit page will ask for the gross amount on this voucher.'
            : 'Open discount on a voucher with nothing owed: check by hand.',
    });
  }

  // ── Notes ──────────────────────────────────────────────────────────────────
  const s3 = wb.addWorksheet('Notes');
  s3.getColumn(1).width = 120;
  [
    `TAFSD-581 audit, read from production on ${today}. Read-only: nothing was changed.`,
    '',
    `Whole-year groups: a student's heads of one fee type covering ${MIN_MONTHS} or more months on a single fee date. Once that date passes, the defaulters report, arrears and the arrear surcharge count every one of those months as owed, so an unpaid group shows the student N months behind at once (up to N × Rs 1,000 surcharge on the next voucher).`,
    'Almost every group is an annual advance payment: most carry a FULL YEAR ADVANCE PAYMENT DISCOUNT. Where the audit log shows a fee schedule bulk save moving the months onto one date, the row names who did it and when; otherwise the heads were written on that date when created.',
    'For finance: confirm which groups are meant to be annual. An unpaid group that is not meant to be annual would be re-dated month by month and its voucher regenerated.',
    '',
    'Discount paid in cash: vouchers carrying a discount that was never used. Until TAFSD-581, an EXPIRED voucher reached the deposit page with no discounted total, so the page asked for the full amount and the discount stayed unused. Every PAID row here was paid after its validity date.',
    'For finance: for each PAID row, compare the recorded deposit with the bank record. Either the deposit overstates cash by the discount, or the discount was forfeited for paying late and should be removed. EXPIRED rows are not paid yet.',
    '',
    'Script: tafs-backend scripts/audit-whole-year-one-fee-date.ts',
  ].forEach((t) => s3.addRow([t]));

  for (const ws of [s1, s2]) {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { wrapText: true, vertical: 'top' };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
    ws.eachRow((row, i) => {
      if (i > 1) row.alignment = { wrapText: true, vertical: 'top' };
    });
  }
  for (const k of ['amt', 'paid', 'out']) s1.getColumn(k).numFmt = '#,##0';
  for (const k of ['da', 'du', 'before', 'after', 'rec', 'diff']) s2.getColumn(k).numFmt = '#,##0';

  await wb.xlsx.writeFile(out);
  const unpaid = s1.getColumn('state').values.filter((v) => v === 'Unpaid' || v === 'Part paid').length;
  const paidGross = risky.filter((r) => r.status === 'PAID');
  console.log(`Whole-year groups: ${groups.length} (${unpaid} not fully paid)`);
  console.log(`Unused discounts: ${risky.length} vouchers, ${paidGross.length} PAID (Rs ${paidGross.reduce((s, r) => s + n(r.discount) - n(r.discount_used), 0).toLocaleString()} recorded as cash)`);
  console.log(`Wrote ${out}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
