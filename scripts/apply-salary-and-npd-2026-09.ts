/**
 * Updated salaries (increments, corrections, first salaries) and NPD security
 * deposits, from "TEACHERS DATA WITH EMPLOYEES CODE AND SALARY.xlsx" (sheet
 * dated 21 Sep 2026).
 *
 *   npx ts-node --transpile-only scripts/apply-salary-and-npd-2026-09.ts            # dry run
 *   APPLY=1 npx ts-node --transpile-only scripts/apply-salary-and-npd-2026-09.ts    # write
 *
 * Idempotent: every write re-reads the live row and skips anything already in
 * its target state, so re-running changes nothing. Each employee is one
 * transaction — a failure rolls back that person only and is reported.
 *
 * Nothing here notifies anyone.
 *
 * ── Decisions (user, 2026-09-22 → 2026-09-24) ─────────────────────────────
 *  - Increments are effective 2026-07-26: the start of the August payroll cycle.
 *  - Three "decreases" were data-entry bugs in the directory: the sheet figure
 *    becomes their salary as a CORRECTION, with no increment recorded.
 *  - Five employees with no salary on record get the sheet figure as their
 *    salary (a first salary, not an increment).
 *  - NPD is a security deposit of exactly one month's salary. The monthly rate
 *    sets the length: 25% runs 4 months, 10% runs 10.
 *  - Uzma Mateen and Iqra Kashif run AUG–NOV, though the sheet shows AUG only.
 *  - Alina Soomro has left and is skipped.
 *  - AGHA TAHIR is MIRZA TAHIR ABBAS; POONAM is DAYAWANTI.
 */
import { Prisma, PrismaClient, SecurityDepositStatus, SecurityDepositTransactionType } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as XLSX from 'xlsx';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
import {
  buildEqualSchedule,
  money,
  scheduleJson,
  shiftScheduleAfterCollection,
} from '../src/modules/hr/installment-schedule.util';

const prisma = new PrismaClient();
const audit = new AuditLogsService(prisma as never, {} as never);
const APPLY = process.env.APPLY === '1';
/** Canary runs: ONLY=GEJ-02-0861,GKF-02-00027 limits writes to those directory codes. */
const ONLY = new Set((process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const FILE = '/Users/aawaizali/Downloads/TEACHERS DATA WITH EMPLOYEES CODE AND SALARY.xlsx';
const ACTOR = 'backfill-salary-npd-2026-09';

/** Start of the August 2026 payroll cycle (26 Jul → 25 Aug). */
const EFFECTIVE = new Date('2026-07-26T00:00:00.000Z');

/**
 * Where automated deposit collection begins: the September cycle
 * (26 Aug → 25 Sep), which has not been run yet.
 *
 * August was deducted outside the system, so it is recorded below as a manual
 * ledger row. Starting the plan in the August cycle instead would let the
 * three leftover DRAFT runs for that already-finalized period pick up a
 * deposit line — and finalizing one would take August a second time.
 */
const SEP_CYCLE_START = new Date('2026-08-26T00:00:00.000Z');
const MONTHS = ['AUG 2026', 'SEP 2026', 'OCT 2026', 'NOV 2026'];

const NOTE = 'Salary sheet 21 Sep 2026';

/** Sheet names that differ from the directory but are the same person. */
const CONFIRMED_SAME_PERSON = new Set([
  '02-00836', // AGHA TAHIR = MIRZA TAHIR ABBAS
  '04-0002', //  POONAM = DAYAWANTI
]);

/**
 * The directory's old figure was a data-entry bug: overwrite it, record no
 * increment. Keyed by the directory's full code so a mis-coded sheet row can't
 * steer a correction onto the wrong person (the sheet files KAINAT WILSON
 * under Nadia Suleman's code).
 */
const CORRECTIONS: Record<string, { name: string; pay: number }> = {
  'GEJ-02-001406': { name: 'KAINAT WILSON', pay: 34000 },
  'GEJ-02-001359': { name: 'FAIZA KHAN', pay: 50000 },
  'NNN-03-00310': { name: 'ERUM SABA OWAIS', pay: 27000 },
};

const SKIP_CODES: Record<string, string> = {
  '02-001514': 'ALINA SOOMRO — left the school',
};

/** NPD plans confirmed as running AUG–NOV though the sheet shows AUG only. */
const NPD_CONFIRMED_FULL_TERM = new Set(['02-001502', '02-001503']); // UZMA MATEEN, IQRA KASHIF

// ─────────────────────────────── helpers ───────────────────────────────

const clean = (v: unknown) => (v == null ? '' : String(v).trim().replace(/\s+/g, ' '));
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));
const normName = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');
const sameName = (a: string, b: string) => {
  const x = normName(a), y = normName(b);
  return x === y || x.includes(y.slice(0, 6)) || y.includes(x.slice(0, 6));
};

/**
 * Sheet codes drop the campus prefix the directory carries ("02-0861" is
 * "GEJ-02-0861"). Match on department + number, with the number kept exactly
 * as written — "0861" and "861" are different people.
 */
function codeKey(raw: string): string | null {
  const nums = clean(raw).toUpperCase().replace(/\s+/g, '-').split('-').filter((p) => /^\d+$/.test(p));
  return nums.length < 2 ? null : `${nums[nums.length - 2]}-${nums[nums.length - 1]}`;
}

/**
 * The directory code PREFIX a sheet's people carry. Prefixes are not campus
 * codes: GKF- sits at campus KNF, NNN- at NNZ.
 */
function codePrefixOfSheet(sheet: string): 'NNN' | 'GKF' | 'GEJ' {
  const s = sheet.trim().toUpperCase();
  if (s === 'NNN') return 'NNN';
  if (s.startsWith('KANEEZ')) return 'GKF';
  return 'GEJ';
}

class Skip extends Error {}

// ─────────────────────────────── read sheet ───────────────────────────────

type Row = { code: string; name: string; salary: number | null; sheet: string };
type NpdRow = Row & { months: (number | null)[] };

function readSheet() {
  const wb = XLSX.readFile(FILE);
  const salary: Row[] = [];
  const npd: NpdRow[] = [];
  for (const sheetName of wb.SheetNames) {
    if (sheetName === 'Sheet1') continue;
    const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    let cols: { code: number; name: number; sal: number } | null = null;
    let monthStart: number | null = null;
    for (const r of rows) {
      const codeIdx = r.findIndex((c) => typeof c === 'string' && /EMPLOYEES CODE/i.test(c));
      if (codeIdx >= 0) {
        cols = { code: codeIdx, name: codeIdx + 1, sal: codeIdx + 2 };
        const aug = r.findIndex((c) => typeof c === 'string' && /AUG 2026/i.test(c));
        monthStart = aug >= 0 ? aug : null;
        continue;
      }
      const augHere = r.findIndex((c) => typeof c === 'string' && /AUG 2026/i.test(c));
      if (augHere >= 0 && cols) { monthStart = augHere; continue; }
      if (!cols) continue;
      const code = clean(r[cols.code]);
      if (!code || !/\d/.test(code)) continue;
      const rec: Row = { code, name: clean(r[cols.name]), salary: num(r[cols.sal]), sheet: sheetName };
      if (!rec.name && rec.salary == null) continue; // empty filler row
      if (sheetName === 'NPD DETAILS') {
        if (monthStart != null) npd.push({ ...rec, months: MONTHS.map((_, i) => num(r[monthStart! + i])) });
      } else {
        salary.push(rec);
      }
    }
  }
  return { salary, npd };
}

// ─────────────────────────────── plan ───────────────────────────────

async function plan() {
  const { salary, npd } = readSheet();
  const employees = await prisma.employee_profiles.findMany({
    select: { id: true, employee_code: true, full_name: true, monthly_pay: true, employment_status: true, increment_cycle_months: true },
  });
  const byKey = new Map<string, typeof employees>();
  for (const e of employees) {
    const k = e.employee_code ? codeKey(e.employee_code) : null;
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  const resolve = (row: Row) => {
    const key = codeKey(row.code);
    let hits = key ? byKey.get(key) ?? [] : [];
    if (hits.length > 1) {
      const want = codePrefixOfSheet(row.sheet);
      const narrowed = hits.filter((h) => (h.employee_code ?? '').toUpperCase().startsWith(want + '-'));
      if (narrowed.length) hits = narrowed;
    }
    return { key, hits };
  };

  /**
   * The sheet reuses codes: 02-001414 carries KAINAT WILSON and NADIA SULEMAN,
   * 03-00639 carries HIRA KHADIM and SUMAYA. Every row is processed, and a
   * duplicated code is resolved per row by name.
   */
  const perCode = new Map<string, number>();
  salary.forEach((r) => { const k = codeKey(r.code) ?? r.code; perCode.set(k, (perCode.get(k) ?? 0) + 1); });

  const increments: any[] = [], corrections: any[] = [], firstSalaries: any[] = [];
  const noChange: any[] = [], report: Record<string, string[]> = {};
  const note = (bucket: string, line: string) => (report[bucket] ??= []).push(line);

  for (const row of salary) {
    const k = codeKey(row.code) ?? '';
    if (SKIP_CODES[k]) { note('Skipped on instruction', `${row.code} ${row.name} — ${SKIP_CODES[k]}`); continue; }

    let { hits } = resolve(row);
    if ((perCode.get(k) ?? 0) > 1) {
      const own = hits.filter((h) => sameName(row.name, h.full_name));
      if (own.length === 1) hits = own;
      else {
        const prefix = codePrefixOfSheet(row.sheet);
        const byName = employees.filter((x) => (x.employee_code ?? '').startsWith(prefix + '-') && normName(x.full_name) === normName(row.name));
        if (byName.length !== 1) {
          note('Duplicate code, person not identified — left out', `${row.code} "${row.name}" sheet=${fmt(row.salary)} (code belongs to ${hits.map((h) => `${h.employee_code} ${h.full_name}`).join(', ')})`);
          continue;
        }
        note('Re-coded by name (sheet used someone else\'s code)', `${row.code} "${row.name}" → ${byName[0].employee_code}`);
        hits = byName;
      }
    }
    if (hits.length === 0) { note('No employee with this code — left out', `${row.code} ${row.name}`); continue; }
    if (hits.length > 1) { note('Ambiguous code — left out', `${row.code} ${row.name} → ${hits.map((h) => h.employee_code).join(', ')}`); continue; }

    const e = hits[0];
    if (row.salary == null) continue;
    if (e.employment_status !== 'ACTIVE') { note('Not active — left out', `${e.employee_code} ${e.full_name} (${e.employment_status})`); continue; }
    if (!CONFIRMED_SAME_PERSON.has(k) && !sameName(row.name, e.full_name) && !CORRECTIONS[e.employee_code ?? '']) {
      note('Name spelled differently (informational)', `${e.employee_code} sheet="${row.name}" directory="${e.full_name}"`);
    }

    const old = e.monthly_pay == null ? null : Number(e.monthly_pay);
    const base = { id: e.id, code: e.employee_code!, name: e.full_name, old };
    const fix = CORRECTIONS[e.employee_code ?? ''];
    if (fix) { if (old !== fix.pay) corrections.push({ ...base, next: fix.pay }); else noChange.push(base); continue; }
    if (old == null) { firstSalaries.push({ ...base, next: row.salary }); continue; }
    if (row.salary > old) increments.push({ ...base, next: row.salary, cycle: e.increment_cycle_months });
    else if (row.salary === old) noChange.push(base);
    else note('Decrease — left out', `${e.employee_code} ${e.full_name} ${fmt(old)} → ${fmt(row.salary)}`);
  }

  // ── NPD ──
  const deposits: any[] = [];
  for (const row of npd) {
    const k = codeKey(row.code) ?? '';
    if (SKIP_CODES[k]) { note('Skipped on instruction', `NPD ${row.code} ${row.name} — ${SKIP_CODES[k]}`); continue; }
    const months = NPD_CONFIRMED_FULL_TERM.has(k) && row.months[0] != null ? row.months.map(() => row.months[0]) : row.months;
    const { hits } = resolve(row);
    if (hits.length !== 1) { note('NPD: code not matched — left out', `${row.code} ${row.name}`); continue; }
    const e = hits[0];
    const rate = months.find((m) => m != null);
    if (rate == null || row.salary == null) continue;
    const count = Math.round(row.salary / rate);
    if (Math.abs(count * rate - row.salary) >= 1) {
      note('NPD: rate does not divide one month\'s salary — left out', `${e.employee_code} ${fmt(row.salary)} ÷ ${fmt(rate)}`);
      continue;
    }
    deposits.push({ id: e.id, code: e.employee_code!, name: e.full_name, total: rate * count, rate, count, aug: months[0] ?? null });
  }

  return { increments, corrections, firstSalaries, noChange, deposits, report };
}

// ─────────────────────────────── writers ───────────────────────────────

type Tx = Prisma.TransactionClient;

/**
 * Put `newPay` into the progression history from `effective` onward, without
 * inverting any period.
 *
 * recordProgressionChange (used by the app's own increment button) always
 * closes the OPEN period at the effective date and opens a new one there. With
 * a backdated date that closes periods before they began: 57 open periods were
 * created by a system backfill on 2026-09-05, so their valid_from is a
 * record-creation date, not the day the pay started. Instead:
 *   - the period that straddles the effective date is split there;
 *   - every period that starts on/after it carries the new pay in place.
 * Refuses if any of those periods already carries a pay other than `oldPay`
 * — that would mean a later change this backfill must not overwrite.
 */
async function writeIncrementHistory(tx: Tx, employeeId: number, oldPay: number, newPay: number) {
  const periods = await tx.employee_progression_periods.findMany({
    where: { employee_id: employeeId },
    orderBy: { valid_from: 'asc' },
  });
  if (periods.length === 0) throw new Skip('no progression history to extend');

  const affected = periods.filter((p) => p.valid_to == null || p.valid_to > EFFECTIVE);
  for (const p of affected) {
    if (p.monthly_pay != null && Number(p.monthly_pay) !== oldPay) {
      throw new Skip(`period #${p.id} (${p.change_type}) already carries ${fmt(Number(p.monthly_pay))}`);
    }
  }

  const straddle = affected.find((p) => p.valid_from < EFFECTIVE);
  if (straddle) {
    await tx.employee_progression_periods.update({ where: { id: straddle.id }, data: { valid_to: EFFECTIVE } });
    await tx.employee_progression_periods.create({
      data: {
        employee_id: employeeId,
        campus_id: straddle.campus_id,
        segment_id: straddle.segment_id,
        department_id: straddle.department_id,
        staff_category_id: straddle.staff_category_id,
        reporting_manager_id: straddle.reporting_manager_id,
        job_title: straddle.job_title,
        employment_type: straddle.employment_type,
        employment_status: straddle.employment_status,
        monthly_pay: newPay,
        payroll_enabled: straddle.payroll_enabled,
        class_sections: straddle.class_sections ?? Prisma.JsonNull,
        change_type: 'SALARY_INCREMENT',
        changed_by: ACTOR,
        notes: NOTE,
        valid_from: EFFECTIVE,
        valid_to: straddle.valid_to,
      },
    });
  }
  const later = affected.filter((p) => p.valid_from >= EFFECTIVE).map((p) => p.id);
  if (later.length) {
    await tx.employee_progression_periods.updateMany({ where: { id: { in: later } }, data: { monthly_pay: newPay } });
  }
  return { split: straddle?.id ?? null, updatedInPlace: later.length };
}

async function applyIncrement(r: any, batch: string, defaultCycle: number) {
  return prisma.$transaction(async (tx) => {
    const e = await tx.employee_profiles.findUniqueOrThrow({ where: { id: r.id } });
    const live = e.monthly_pay == null ? null : Number(e.monthly_pay);
    if (live === r.next) throw new Skip('already at the new salary');
    if (live !== r.old) throw new Skip(`salary changed since planning: now ${fmt(live)}`);
    if (e.employment_status !== 'ACTIVE') throw new Skip(`status is ${e.employment_status}`);

    const hist = await writeIncrementHistory(tx, r.id, r.old, r.next);
    await tx.employee_profiles.update({ where: { id: r.id }, data: { monthly_pay: r.next, last_increment_at: EFFECTIVE } });
    await tx.salary_increments.create({
      data: {
        employee_id: r.id,
        mode: 'FIXED_AMOUNT',
        percentage: null,
        fixed_amount: r.next - r.old,
        previous_pay: r.old,
        new_pay: r.next,
        cycle_months_used: r.cycle ?? defaultCycle,
        effective_from: EFFECTIVE,
        applied_by: ACTOR,
        notes: NOTE,
        bulk_batch_id: batch,
      },
    });
    await audit.log({
      entity_type: 'EMPLOYEE', entity_id: String(r.id), action: 'SALARY_INCREMENT_APPLIED',
      section: 'salary', field: 'monthly_pay', old_value: String(r.old), new_value: String(r.next),
      changed_by: ACTOR, note: `Increment effective ${EFFECTIVE.toISOString().slice(0, 10)} from the ${NOTE}.`,
    } as never);
    return hist;
  });
}

/**
 * The old figure never existed — it was a data-entry bug (corrections), or
 * there was no figure at all (first salaries). Rewrite every period that
 * carried it, so history reads as if the right pay had always been there.
 * No salary_increments row: nobody got a raise.
 */
async function applySalarySet(r: any, kind: 'CORRECTION' | 'FIRST_SALARY') {
  return prisma.$transaction(async (tx) => {
    const e = await tx.employee_profiles.findUniqueOrThrow({ where: { id: r.id } });
    const live = e.monthly_pay == null ? null : Number(e.monthly_pay);
    if (live === r.next) throw new Skip('already at the target salary');
    if (live !== r.old) throw new Skip(`salary changed since planning: now ${fmt(live)}`);

    await tx.employee_profiles.update({ where: { id: r.id }, data: { monthly_pay: r.next } });
    const rewritten = await tx.employee_progression_periods.updateMany({
      where: { employee_id: r.id, ...(r.old == null ? { monthly_pay: null } : { monthly_pay: r.old }) },
      data: { monthly_pay: r.next },
    });
    await audit.log({
      entity_type: 'EMPLOYEE', entity_id: String(r.id), action: kind === 'CORRECTION' ? 'SALARY_CORRECTED' : 'SALARY_SET',
      section: 'salary', field: 'monthly_pay', old_value: r.old == null ? null : String(r.old), new_value: String(r.next),
      changed_by: ACTOR,
      note: kind === 'CORRECTION'
        ? `Previous figure was a data-entry error; corrected from the ${NOTE}. Not an increment.`
        : `First salary on record, from the ${NOTE}.`,
    } as never);
    return { periodsRewritten: rewritten.count };
  });
}

/**
 * Create the plan, and record AUGUST only — it was deducted outside the
 * system. SEPTEMBER is deliberately not recorded: its payroll cycle has not
 * been run, and when it is, it deducts the next installment from this plan
 * automatically. Recording it here too would take it twice.
 */
async function applyDeposit(d: any) {
  return prisma.$transaction(async (tx) => {
    const open = await tx.employee_security_deposits.findFirst({
      where: { employee_id: d.id, status: { in: [SecurityDepositStatus.ACTIVE, SecurityDepositStatus.COMPLETED] } },
    });
    if (open) throw new Skip(`already has an open plan (#${open.id})`);

    const total = money(d.total);
    const full = buildEqualSchedule(total, d.count);
    let schedule = full, recovered = money(0);
    if (d.aug != null) {
      recovered = money(d.aug);
      schedule = shiftScheduleAfterCollection(scheduleJson(full), money(full[0]), true, total.minus(recovered)).schedule;
    }
    const plan = await tx.employee_security_deposits.create({
      data: {
        employee_id: d.id,
        total_amount: total,
        installment_count: schedule.length,
        installment_amount: money(schedule[0] ?? 0),
        installment_schedule: scheduleJson(schedule),
        start_period_start: SEP_CYCLE_START,
        recovered_amount: recovered,
        status: SecurityDepositStatus.ACTIVE,
        notes: `NPD: one month's salary over ${d.count} months at ${fmt(d.rate)}/month. ${NOTE}.`,
        created_by: ACTOR,
      },
    });
    if (d.aug != null) {
      await tx.employee_security_deposit_transactions.create({
        data: {
          deposit_id: plan.id,
          type: SecurityDepositTransactionType.DEDUCTION,
          payroll_run_line_id: null,
          due_amount: recovered,
          amount: recovered,
          running_balance: recovered,
          reason: 'August 2026 NPD, deducted outside the system before this plan existed (NPD sheet).',
          created_by: ACTOR,
        },
      });
    }
    await audit.log({
      entity_type: 'EMPLOYEE', entity_id: String(d.id), action: 'SECURITY_DEPOSIT_CREATED',
      changed_by: ACTOR,
      note: `NPD plan ${fmt(d.total)} over ${d.count} months${d.aug != null ? `, August ${fmt(d.aug)} recorded as collected` : ''}.`,
    } as never);
    return { planId: plan.id, remainingMonths: schedule.length };
  });
}

// ─────────────────────────────── main ───────────────────────────────

(async () => {
  const p = await plan();
  const sum = (rows: any[], f: (r: any) => number) => rows.reduce((s, r) => s + f(r), 0);

  console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN (APPLY=1 to write) ===');
  console.log(`Effective ${EFFECTIVE.toISOString().slice(0, 10)} · deposit collection from ${SEP_CYCLE_START.toISOString().slice(0, 10)}\n`);
  console.log(`Increments      ${p.increments.length}  (+${fmt(sum(p.increments, (r) => r.next - r.old))}/month)`);
  console.log(`Corrections     ${p.corrections.length}`);
  console.log(`First salaries  ${p.firstSalaries.length}`);
  console.log(`No change       ${p.noChange.length}`);
  console.log(`Deposit plans   ${p.deposits.length}  (liability ${fmt(sum(p.deposits, (d) => d.total))}; August recorded for ${p.deposits.filter((d) => d.aug != null).length} = ${fmt(sum(p.deposits, (d) => d.aug ?? 0))})`);
  for (const [bucket, lines] of Object.entries(p.report)) {
    console.log(`\n${bucket} (${lines.length}):`);
    lines.forEach((l) => console.log(`  ${l}`));
  }
  if (!APPLY) {
    // Predict writeIncrementHistory without writing.
    const periods = await prisma.employee_progression_periods.findMany({
      where: { employee_id: { in: p.increments.map((r) => r.id) } },
      orderBy: { valid_from: 'asc' },
    });
    let split = 0, inPlace = 0;
    const refuse: string[] = [];
    for (const r of p.increments) {
      const mine = periods.filter((x) => x.employee_id === r.id);
      const affected = mine.filter((x) => x.valid_to == null || x.valid_to > EFFECTIVE);
      const clash = affected.find((x) => x.monthly_pay != null && Number(x.monthly_pay) !== r.old);
      if (!mine.length) { refuse.push(`${r.code} ${r.name} — no history`); continue; }
      if (clash) { refuse.push(`${r.code} ${r.name} — period #${clash.id} ${clash.change_type} carries ${fmt(Number(clash.monthly_pay))}, expected ${fmt(r.old)}`); continue; }
      if (affected.some((x) => x.valid_from < EFFECTIVE)) split++; else inPlace++;
    }
    console.log(`\nHistory: ${split} split at ${EFFECTIVE.toISOString().slice(0, 10)}, ${inPlace} rewritten in place (period began after it), ${refuse.length} would be refused`);
    refuse.forEach((l) => console.log(`  refuse: ${l}`));

    console.log('\nCorrections:'); p.corrections.forEach((r) => console.log(`  ${r.code} ${r.name} ${fmt(r.old)} → ${fmt(r.next)}`));
    console.log('First salaries:'); p.firstSalaries.forEach((r) => console.log(`  ${r.code} ${r.name} → ${fmt(r.next)}`));
    console.log('\nNOTHING WAS WRITTEN.');
    await prisma.$disconnect();
    return;
  }

  const settings = await prisma.salary_increment_settings.findUnique({ where: { id: 1 } });
  const defaultCycle = settings?.default_cycle_months ?? 12;
  const batch = randomUUID();
  const done: Record<string, number> = {};
  const problems: string[] = [];
  const run = async (label: string, rows: any[], fn: (r: any) => Promise<unknown>) => {
    done[label] = 0;
    for (const r of rows) {
      try { await fn(r); done[label]++; }
      catch (err: any) { problems.push(`${label}: ${r.code} ${r.name} — ${err instanceof Skip ? 'skipped: ' : 'FAILED: '}${err.message}`); }
    }
  };
  const pick = <T extends { code: string }>(rows: T[]) => (ONLY.size ? rows.filter((r) => ONLY.has(r.code)) : rows);
  if (ONLY.size) console.log(`\nCANARY: limited to ${[...ONLY].join(', ')}`);
  await run('increment', pick(p.increments), (r) => applyIncrement(r, batch, defaultCycle));
  await run('correction', pick(p.corrections), (r) => applySalarySet(r, 'CORRECTION'));
  await run('first salary', pick(p.firstSalaries), (r) => applySalarySet(r, 'FIRST_SALARY'));
  await run('deposit', pick(p.deposits), (d) => applyDeposit(d));

  console.log('\nWritten:', Object.entries(done).map(([k, v]) => `${k} ${v}`).join(' · '));
  console.log(`Increment batch id: ${batch}`);
  if (problems.length) { console.log(`\nNot written (${problems.length}):`); problems.forEach((l) => console.log(`  ${l}`)); }
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAILED:', e); await prisma.$disconnect(); process.exit(1); });
