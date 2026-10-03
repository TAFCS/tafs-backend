/**
 * Independent audit of the salary + NPD backfill against the whole Excel file.
 * Read-only.
 *
 *   npx ts-node --transpile-only scripts/audit-salary-and-npd-2026-09.ts
 *
 * Deliberately does NOT reuse the apply script's parser: that parser assumed
 * name = code column + 1 and salary = code column + 2, which is false on the
 * KANEEZ FATIMA sheet (name and salary sit two columns further right, under
 * duplicate headers), and every Kaneez Fatima row was silently dropped as
 * "no salary". Here each value is found by what it looks like: the code is the
 * cell shaped like an employee code, the name is the first text cell after it,
 * the salary is the first number after the name.
 */
import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';

const prisma = new PrismaClient();
const FILE = '/Users/aawaizali/Downloads/TEACHERS DATA WITH EMPLOYEES CODE AND SALARY.xlsx';
const MONTHS = ['AUG 2026', 'SEP 2026', 'OCT 2026', 'NOV 2026'];

// Same decisions as the apply script.
const CORRECTIONS: Record<string, number> = { 'GEJ-02-001406': 34000, 'GEJ-02-001359': 50000, 'NNN-03-00310': 27000 };
const SKIP = new Set(['02-001514']); // Alina Soomro, left
const FULL_TERM = new Set(['02-001502', '02-001503']);

const clean = (v: unknown) => (v == null ? '' : String(v).trim().replace(/\s+/g, ' '));
const CODE_RE = /^(?:[A-Z]{2,4}[\s-]*)?\d{2}\s*-\s*\d{2,}$/i;
const isCode = (v: unknown) => typeof v === 'string' && CODE_RE.test(clean(v));
const codeKey = (raw: string) => { const n = clean(raw).toUpperCase().replace(/\s+/g, '-').split('-').filter((p) => /^\d+$/.test(p)); return n.length < 2 ? null : `${n[n.length - 2]}-${n[n.length - 1]}`; };
const prefixOf = (sheet: string) => { const s = sheet.trim().toUpperCase(); return s === 'NNN' ? 'NNN' : s.startsWith('KANEEZ') ? 'GKF' : 'GEJ'; };
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');
const same = (a: string, b: string) => { const x = norm(a), y = norm(b); return x === y || x.includes(y.slice(0, 5)) || y.includes(x.slice(0, 5)); };
const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

type SalRow = { sheet: string; line: number; code: string; name: string; salary: number | null };
function readSalary(wb: XLSX.WorkBook): SalRow[] {
  const out: SalRow[] = [];
  for (const sheet of wb.SheetNames) {
    if (sheet === 'Sheet1' || sheet === 'NPD DETAILS') continue;
    const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sheet], { header: 1, raw: true, defval: null });
    rows.forEach((r, i) => {
      const ci = r.findIndex((c, j) => j <= 3 && isCode(c));
      if (ci < 0) return;
      const ni = r.findIndex((c, j) => j > ci && typeof c === 'string' && clean(c) && !isCode(c));
      const si = ni < 0 ? -1 : r.findIndex((c, j) => j > ni && typeof c === 'number');
      out.push({ sheet, line: i + 1, code: clean(r[ci]), name: ni < 0 ? '' : clean(r[ni]), salary: si < 0 ? null : r[si] });
    });
  }
  return out;
}

(async () => {
  const wb = XLSX.readFile(FILE);
  const salary = readSalary(wb);
  const emps = await prisma.employee_profiles.findMany({ select: { id: true, employee_code: true, full_name: true, monthly_pay: true, employment_status: true } });
  const byKey = new Map<string, typeof emps>();
  emps.forEach((e) => { const k = e.employee_code ? codeKey(e.employee_code) : null; if (k) byKey.set(k, [...(byKey.get(k) ?? []), e]); });

  const resolve = (row: { code: string; name: string; sheet: string }) => {
    const k = codeKey(row.code) ?? '';
    let hits = byKey.get(k) ?? [];
    if (hits.length > 1) { const w = hits.filter((h) => (h.employee_code ?? '').startsWith(prefixOf(row.sheet) + '-')); if (w.length) hits = w; }
    if (hits.length > 1 || (hits.length === 1 && row.name && !same(row.name, hits[0].full_name))) {
      const byName = emps.filter((e) => (e.employee_code ?? '').startsWith(prefixOf(row.sheet) + '-') && norm(e.full_name) === norm(row.name));
      if (byName.length === 1) return { e: byName[0], note: `name-matched (sheet code ${row.code} belongs to someone else)` };
    }
    return hits.length === 1 ? { e: hits[0], note: '' } : { e: null, note: hits.length ? 'ambiguous' : 'no employee with this code' };
  };

  // ── SALARY ──
  const buckets: Record<string, string[]> = { OK: [], WRONG: [], UNMATCHED: [], NO_SALARY: [], SKIPPED: [] };
  const perSheet = new Map<string, { rows: number; ok: number; wrong: number }>();
  for (const row of salary) {
    const ps = perSheet.get(row.sheet) ?? { rows: 0, ok: 0, wrong: 0 }; ps.rows++; perSheet.set(row.sheet, ps);
    const tag = `[${row.sheet.trim()} r${row.line}] ${row.code.padEnd(14)} ${row.name.slice(0, 22).padEnd(23)}`;
    if (SKIP.has(codeKey(row.code) ?? '')) { buckets.SKIPPED.push(`${tag} left the school`); continue; }
    if (row.salary == null) { buckets.NO_SALARY.push(`${tag} no salary figure in the row`); continue; }
    const { e, note } = resolve(row);
    if (!e) { buckets.UNMATCHED.push(`${tag} sheet=${fmt(row.salary)}  ${note}`); continue; }
    const want = CORRECTIONS[e.employee_code ?? ''] ?? row.salary;
    const have = e.monthly_pay == null ? null : Number(e.monthly_pay);
    const line = `${tag} -> ${String(e.employee_code).padEnd(15)} sheet=${fmt(row.salary).padStart(7)} db=${fmt(have).padStart(7)}${want !== row.salary ? ` (correction ${fmt(want)})` : ''}${note ? '  ' + note : ''}${e.employment_status !== 'ACTIVE' ? '  [' + e.employment_status + ']' : ''}`;
    if (have === want) { buckets.OK.push(line); ps.ok++; } else { buckets.WRONG.push(line); ps.wrong++; }
  }

  console.log(`SALARY — ${salary.length} rows with an employee code across ${perSheet.size} sheets`);
  for (const [s, v] of perSheet) console.log(`  ${s.trim().padEnd(16)} rows=${String(v.rows).padStart(3)}  correct=${String(v.ok).padStart(3)}  WRONG=${v.wrong}`);
  for (const k of ['WRONG', 'UNMATCHED', 'NO_SALARY', 'SKIPPED']) {
    if (!buckets[k].length) continue;
    console.log(`\n${k} (${buckets[k].length}):`); buckets[k].forEach((l) => console.log('  ' + l));
  }
  console.log(`\ncorrect: ${buckets.OK.length}`);

  // ── NPD ──
  const npdRows: { code: string; name: string; salary: number | null; months: (number | null)[]; sheet: string }[] = [];
  {
    const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets['NPD DETAILS'], { header: 1, raw: true, defval: null });
    let aug = -1;
    for (const r of rows) {
      const a = r.findIndex((c) => typeof c === 'string' && /AUG 2026/i.test(c)); if (a >= 0) { aug = a; }
      const ci = r.findIndex((c, j) => j <= 3 && isCode(c)); if (ci < 0 || aug < 0) continue;
      npdRows.push({ code: clean(r[ci]), name: clean(r[ci + 1]), salary: typeof r[ci + 2] === 'number' ? r[ci + 2] : null, months: MONTHS.map((_, i) => (typeof r[aug + i] === 'number' ? r[aug + i] : null)), sheet: 'NPD DETAILS' });
    }
  }
  const plans = await prisma.employee_security_deposits.findMany({ include: { transactions: true } });
  console.log(`\n\nNPD — ${npdRows.length} rows in NPD DETAILS`);
  let npdOk = 0; const npdBad: string[] = [];
  for (const r of npdRows) {
    const k = codeKey(r.code) ?? '';
    if (SKIP.has(k)) { npdBad.push(`SKIPPED   ${r.code} ${r.name} (left)`); continue; }
    const months = FULL_TERM.has(k) && r.months[0] != null ? r.months.map(() => r.months[0]) : r.months;
    const rate = months.find((m) => m != null) ?? null;
    const sheetGuess = /^GKF/i.test(r.code) ? 'KANEEZ FATIMA' : r.code.startsWith('02-007') ? 'NNN' : 'GEJ';
    const { e } = resolve({ ...r, sheet: sheetGuess });
    if (!e || rate == null || r.salary == null) { npdBad.push(`UNMATCHED ${r.code} ${r.name}`); continue; }
    const mine = plans.filter((p) => p.employee_id === e.id && ['ACTIVE', 'COMPLETED'].includes(p.status));
    const problems: string[] = [];
    if (mine.length !== 1) problems.push(`${mine.length} open plans`);
    const p = mine[0];
    if (p) {
      const count = Math.round(r.salary / rate);
      if (Number(p.total_amount) !== r.salary) problems.push(`total ${fmt(Number(p.total_amount))} != salary ${fmt(r.salary)}`);
      const sched = (p.installment_schedule as number[]) ?? [];
      if (sched.some((x) => x !== rate)) problems.push(`schedule has ${JSON.stringify(sched)} not ${rate}`);
      const augTx = p.transactions.filter((t) => t.type === 'DEDUCTION' && t.payroll_run_line_id == null);
      const wantAug = months[0] ?? 0;
      const gotAug = augTx.reduce((s, t) => s + Number(t.amount), 0);
      if (gotAug !== wantAug) problems.push(`August recorded ${fmt(gotAug)} != sheet ${fmt(wantAug)}`);
      if (Number(p.recovered_amount) + sched.reduce((a, b) => a + b, 0) !== Number(p.total_amount)) problems.push('recovered + schedule != total');
      if (sched.length + (wantAug ? 1 : 0) !== count) problems.push(`${sched.length} left + ${wantAug ? 1 : 0} collected != ${count} months`);
      if (p.start_period_start.toISOString().slice(0, 10) !== '2026-08-26') problems.push(`starts ${p.start_period_start.toISOString().slice(0, 10)}`);
    }
    if (problems.length) npdBad.push(`WRONG     ${r.code.padEnd(14)} ${r.name.padEnd(20)} ${problems.join('; ')}`);
    else npdOk++;
  }
  console.log(`  correct: ${npdOk}   problems: ${npdBad.length}`);
  npdBad.forEach((l) => console.log('  ' + l));

  // The KANEEZ FATIMA sheet carries its own NPD column — does it agree with NPD DETAILS?
  const kf = XLSX.utils.sheet_to_json<any[]>(wb.Sheets['KANEEZ FATIMA'], { header: 1, raw: true, defval: null });
  const npdCol = kf.find((r) => r.includes('NPD'))?.indexOf('NPD') ?? -1;
  if (npdCol >= 0) {
    console.log('\nKANEEZ FATIMA sheet NPD column vs NPD DETAILS:');
    for (const r of kf) {
      const ci = r.findIndex((c, j) => j <= 3 && isCode(c)); if (ci < 0 || typeof r[npdCol] !== 'number') continue;
      const d = npdRows.find((x) => codeKey(x.code) === codeKey(clean(r[ci])));
      const detail = d?.months.find((m) => m != null) ?? null;
      console.log(`  ${clean(r[ci]).padEnd(14)} sheet NPD ${fmt(r[npdCol])}  NPD DETAILS ${fmt(detail)}  ${detail === r[npdCol] ? 'agree' : 'DIFFER'}`);
    }
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAILED:', e); await prisma.$disconnect(); process.exit(1); });
