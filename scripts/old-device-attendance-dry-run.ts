/**
 * DRY RUN — read-only. Matches the standalone device's exported names against
 * `employee_profiles.full_name`, then reports exactly what an import of
 * `old-device-attendance/*.xls` would insert, skip, or need a human to decide.
 *
 * Writes nothing to the DB. Emits CSVs next to the repo.
 *
 * Usage: npx ts-node scripts/old-device-attendance-dry-run.ts
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { extractAll, DevicePunch } from './old-device-attendance-extract';

const prisma = new PrismaClient();
const OUT_DIR = join(__dirname, '../..');

const WINDOW_START = '2026-07-27';
// Extended past the originally requested 26 Aug on the user's instruction —
// 08Summary.xls runs to the 30th and those days are wanted too.
const WINDOW_END = '2026-08-30';

/**
 * The old device's clock runs behind the live device. Measured against 2,649
 * punches that appear on both, the offset sits hard at +2 minutes (2,204 at +2,
 * 367 at +1). Every imported timestamp is shifted forward by this much so the
 * backfilled scans sit on the same timeline as everything already stored.
 */
const CLOCK_OFFSET_MIN = 2;

/**
 * Operator decisions on the names the matcher would not resolve on its own,
 * keyed by the device PIN the name sits on. 'SKIP' means do not import that
 * device user at all. Confirmed by the user 2 Sep 2026.
 */
const RESOLUTIONS: Record<string, number | 'SKIP'> = {
  '4481': 135,    // "faizakhan"     -> FAIZA KHAN, GEJ-02-001359 (the elder of two identical names)
  '5': 112,       // "amana"         -> AMMARA HASSAN, GEJ-02-001337
  '4399': 124,    // "sabika"        -> SYEDA SABIKAH HASSAN NAQVI, GEJ-02-001338
  '6': 'SKIP',    // "muhammadasif"  -> no matching employee; not backfilled
  '7': 'SKIP',    // shared/supervisor finger: 12-18 punches a day, not one person
  '4670': 'SKIP', // "nusrat"        -> resolves to NUSTRAT RAHAT, already fully covered
  '4390': 162,    // "syed murtaza"  -> MURTAZA HUSSAIN, GEJ-03-00591
  '4523': 'SKIP', // "tasaleem"      -> TASLEEEM match not confirmed; not backfilled
  '4532': 'SKIP', // "tasleem"       -> same person's second device user; not backfilled
  '4434': 126,    // "bushra"        -> BUSHRA IJAZ, GEJ-02-001348
  '4757': 99,     // "areeba riaz"   -> AREEBA AZHAR, GEJ-02-001476
  // Still undecided, deliberately left out of this map so they stay visible in
  // the unmatched list rather than being silently dropped:
  //   "shan" pin 4741, "Shakeela Ishtia" pin 1385
};

/**
 * Punches on days the system currently records as EXCUSED/SYSTEM are imported
 * rather than held: the user resolves holidays and day statuses themselves, and
 * wants the raw scans present to do it from. They are flagged in the plan.
 */
const IMPORT_ON_SYSTEM_DAYS = true;

// Titles the device operators typed into the name field. They exist on no
// `full_name` in the DB, so leaving them in makes every "Mrs X" unmatchable.
const HONORIFICS = new Set(['MR', 'MRS', 'MS', 'MISS', 'SIR', 'MADAM', 'DR', 'MST']);

// Tokens that carry no identifying weight on their own — family prefixes shared
// by dozens of unrelated staff. A candidate matched only on these is not a match.
const WEAK_TOKENS = new Set([
  'SYED', 'SYEDA', 'MUHAMMAD', 'MOHAMMAD', 'MD', 'BIBI', 'BEGUM', 'KHAN',
  'ALI', 'HUSSAIN', 'AHMED', 'AHMAD', 'FATIMA', 'MIRZA', 'SHAH',
]);

interface Emp {
  id: number;
  full_name: string;
  employee_code: string | null;
  status: string;
  campus: string | null;
  tokens: string[];
  squashed: string;
}

function norm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}
function tokensOf(s: string): string[] {
  const n = norm(s);
  return n ? n.split(' ') : [];
}
function deviceTokens(s: string): string[] {
  const t = tokensOf(s);
  // Strip leading titles only — "MS" inside a name is a real token nowhere here.
  let i = 0;
  while (i < t.length - 1 && HONORIFICS.has(t[i])) i++;
  return t.slice(i);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

type Tier = 'EXACT' | 'PREFIX' | 'TOKENS' | 'FUZZY' | 'LOOSE';
const TIER_ORDER: Tier[] = ['EXACT', 'PREFIX', 'TOKENS', 'FUZZY', 'LOOSE'];

interface Candidate { emp: Emp; tier: Tier; score: number; why: string }

/**
 * The device truncates names at 15 characters and its operators typed them
 * freehand ("Mrs Shabana Ash", "muhammadasif"), so equality is rarely enough.
 * Candidates are gathered per tier, best tier wins, and a tier whose top two
 * candidates are close is handed back whole for a human to decide.
 */
function candidatesFor(rawName: string, emps: Emp[]): { list: Candidate[]; decided: boolean } {
  const dTokens = deviceTokens(rawName);
  if (dTokens.length === 0) return { list: [], decided: false };
  const dSquash = dTokens.join('');
  const truncated = rawName.trim().length >= 15;

  const byTier: Record<Tier, Candidate[]> = { EXACT: [], PREFIX: [], TOKENS: [], FUZZY: [], LOOSE: [] };

  for (const e of emps) {
    if (dSquash === e.squashed) {
      byTier.EXACT.push({ emp: e, tier: 'EXACT', score: 1, why: 'squashed name identical' });
      continue;
    }
    if (dSquash.length >= 7 && e.squashed.startsWith(dSquash)) {
      byTier.PREFIX.push({
        emp: e, tier: 'PREFIX', score: dSquash.length / e.squashed.length,
        why: truncated ? 'device name truncated at 15 chars; DB name extends it' : 'DB name extends device name',
      });
      continue;
    }

    // Token containment, scored by how each token landed. An exact token hit
    // must outrank a fuzzy one — otherwise "avesha" prefers AYESHA over the
    // literal AVESHA KHAN sitting right there.
    const dbPool = [...e.tokens];
    let ok = true;
    let strong = 0;
    let quality = 0;
    for (let i = 0; i < dTokens.length; i++) {
      const t = dTokens[i];
      const isLast = i === dTokens.length - 1;
      let idx = dbPool.findIndex((x) => x === t);
      let q = 1;
      if (idx < 0 && t.length >= 3) {
        idx = dbPool.findIndex((x) => x.startsWith(t) || (isLast && t.startsWith(x) && x.length >= 4));
        q = 0.7;
      }
      if (idx < 0 && t.length >= 4) {
        idx = dbPool.findIndex((x) => similarity(x, t) >= 0.8);
        q = 0.45;
      }
      if (idx < 0) { ok = false; break; }
      if (!WEAK_TOKENS.has(t)) { strong++; quality += q; } else { quality += q * 0.25; }
      dbPool.splice(idx, 1);
    }
    if (ok && strong >= 1 && dSquash.length >= 5) {
      // Unconsumed DB tokens are a mild penalty (device drops middle names),
      // never enough to let a fuzzy hit overtake an exact one.
      byTier.TOKENS.push({
        emp: e, tier: 'TOKENS', score: quality - dbPool.length * 0.03,
        why: `${dTokens.length} device token(s) matched (quality ${quality.toFixed(2)}), ${dbPool.length} DB token(s) unused`,
      });
      continue;
    }

    if (dSquash.length >= 6) {
      // For a truncated device name, only compare against the same many chars
      // of the DB name — the tail it never got to record can't count against it.
      const cmp = truncated ? e.squashed.slice(0, Math.max(dSquash.length, 6)) : e.squashed;
      const s = similarity(dSquash, cmp);
      if (s >= 0.75) byTier.FUZZY.push({ emp: e, tier: 'FUZZY', score: s, why: `${(s * 100).toFixed(0)}% character similarity${truncated ? ' (on the truncated prefix)' : ''}` });
      continue;
    }

    // LOOSE — last resort. Device names carry father names and honorific noise
    // the DB never stored ("Shakeela Ishtia", "syed murtaza"), so require only
    // one solid distinctive token to land and let the rest go unmatched. These
    // are never auto-accepted; they exist so the reviewer gets a name to judge
    // instead of a bare "no match".
    {
      let hits = 0;
      let misses = 0;
      for (const t of dTokens) {
        if (t.length < 4 || WEAK_TOKENS.has(t)) continue;
        if (e.tokens.some((x) => x === t || x.startsWith(t) || (x.length >= 4 && t.startsWith(x)))) hits++;
        else misses++;
      }
      if (hits >= 1) {
        byTier.LOOSE.push({
          emp: e, tier: 'LOOSE', score: hits - misses * 0.5 - e.tokens.length * 0.02,
          why: `${hits} distinctive token(s) shared; ${misses} device token(s) absent from the DB name`,
        });
      }
    }
  }

  for (const tier of TIER_ORDER) {
    if (byTier[tier].length) {
      const best = byTier[tier].sort((a, b) => b.score - a.score);
      // A clear winner is a match; a near-tie is a decision for a human.
      const margin = tier === 'TOKENS' ? 0.25 : tier === 'FUZZY' ? 0.05 : tier === 'LOOSE' ? 0.3 : 1e-9;
      const rivals = best.filter((c) => best[0].score - c.score <= margin);
      if (tier === 'LOOSE') return { list: best.slice(0, 6), decided: false };
      return rivals.length === 1 ? { list: [best[0]], decided: true } : { list: rivals, decided: false };
    }
  }
  return { list: [], decided: false };
}

/** Device HH:MM plus the measured clock offset, rolled into a full timestamp. */
function shift(date: string, time: string): { date: string; time: string; rolled: boolean } {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m));
  d.setUTCMinutes(d.getUTCMinutes() + CLOCK_OFFSET_MIN);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), rolled: iso.slice(0, 10) !== date };
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(name: string, rows: Record<string, unknown>[]): void {
  if (!rows.length) return;
  const header = Object.keys(rows[0]);
  writeFileSync(
    join(OUT_DIR, name),
    [header.join(','), ...rows.map((r) => header.map((h) => csvEscape(r[h])).join(','))].join('\n') + '\n',
  );
  console.log(`  wrote ${name} (${rows.length} rows)`);
}

async function main() {
  const { punches, users } = extractAll();

  const empRows = await prisma.$queryRaw<any[]>`
    SELECT e.id, e.full_name, e.employee_code, e.employment_status::text AS status,
           c.campus_name AS campus
    FROM employee_profiles e LEFT JOIN campuses c ON c.id = e.campus_id
    WHERE e.full_name IS NOT NULL`;
  const emps: Emp[] = empRows.map((r) => ({
    ...r,
    tokens: tokensOf(r.full_name),
    squashed: tokensOf(r.full_name).join(''),
  }));

  // ── Window ────────────────────────────────────────────────────────────────
  const inWindow = (p: DevicePunch) => p.date >= WINDOW_START && p.date <= WINDOW_END;
  const kept = punches.filter(inWindow);
  const dropped = punches.filter((p) => !inWindow(p));

  const activeUsers = users.filter((u) => u.punchCount > 0);
  const punchesByUser = new Map<string, DevicePunch[]>();
  for (const p of kept) {
    const k = `${p.file}|${p.devicePin}`;
    (punchesByUser.get(k) ?? punchesByUser.set(k, []).get(k)!).push(p);
  }

  // ── Match each distinct device name once ──────────────────────────────────
  const matchCache = new Map<string, { list: Candidate[]; decided: boolean }>();
  const matched: any[] = [];
  const ambiguous: any[] = [];
  const unmatched: any[] = [];
  const skipped: any[] = [];

  // Same person appears in both months under the same pin; merge on name+pin.
  const merged = new Map<string, { pins: Set<string>; name: string; punches: DevicePunch[]; truncated: boolean }>();
  for (const u of activeUsers) {
    const key = `${u.rawName}||${u.devicePin}`;
    const e = merged.get(key) ?? { pins: new Set<string>(), name: u.rawName, punches: [], truncated: u.nameLooksTruncated };
    e.pins.add(u.devicePin);
    e.punches.push(...(punchesByUser.get(`${u.file}|${u.devicePin}`) ?? []));
    merged.set(key, e);
  }

  for (const [, u] of merged) {
    if (u.punches.length === 0) continue;
    if (!u.name) {
      unmatched.push({ device_pin: [...u.pins].join('/'), device_name: '(blank)', punches: u.punches.length,
        days: new Set(u.punches.map((p) => p.date)).size, reason: 'device user has no name registered' });
      continue;
    }
    const decision = [...u.pins].map((pin) => RESOLUTIONS[pin]).find((d) => d !== undefined);
    if (decision === 'SKIP') {
      skipped.push({ device_pin: [...u.pins].join('/'), device_name: u.name,
        punches: u.punches.length, days: new Set(u.punches.map((p) => p.date)).size,
        reason: 'excluded by operator decision' });
      continue;
    }
    let res = matchCache.get(u.name);
    if (!res) { res = candidatesFor(u.name, emps); matchCache.set(u.name, res); }
    // A resolved PIN overrides whatever the matcher thought.
    if (typeof decision === 'number') {
      const emp = emps.find((e) => e.id === decision);
      if (!emp) throw new Error(`RESOLUTIONS points at employee ${decision}, which does not exist`);
      res = { list: [{ emp, tier: 'EXACT', score: 1, why: 'resolved by operator' }], decided: true };
    }
    const cands = res.list;
    const days = new Set(u.punches.map((p) => p.date));
    const base = { device_pin: [...u.pins].join('/'), device_name: u.name, truncated: u.truncated,
      punches: u.punches.length, days: days.size,
      first_day: [...days].sort()[0], last_day: [...days].sort().slice(-1)[0] };
    if (cands.length === 1 && res.decided) matched.push({ ...base, employee_id: cands[0].emp.id, db_name: cands[0].emp.full_name,
      employee_code: cands[0].emp.employee_code, status: cands[0].emp.status, campus: cands[0].emp.campus,
      tier: cands[0].tier, confidence: cands[0].tier === 'EXACT' ? 'HIGH' : cands[0].tier === 'PREFIX' ? 'HIGH' : cands[0].tier === 'TOKENS' ? 'MEDIUM' : 'LOW', why: cands[0].why });
    else if (cands.length >= 1) ambiguous.push({ ...base, tier: cands[0].tier,
      candidate_count: cands.length, _cands: cands,
      candidates: cands.slice(0, 6).map((c) => `${c.emp.full_name} [id ${c.emp.id}, ${c.emp.employee_code ?? 'no code'}, ${c.emp.status}]`).join(' | ') });
    else unmatched.push({ ...base, reason: 'no employee_profiles.full_name within matching threshold' });
  }

  // ── Overlap with what the DB already has ──────────────────────────────────
  // Candidate employees are pulled in too, so the review list can say whether
  // resolving a name would actually add anything or is already covered.
  const empIds = [...new Set([
    ...matched.map((m) => m.employee_id),
    ...ambiguous.flatMap((a: any) => a._cands.map((c: Candidate) => c.emp.id)),
  ])];
  const scanRows = empIds.length ? await prisma.$queryRawUnsafe<any[]>(
    `SELECT employee_id, attendance_date::text AS d, COUNT(*)::int AS n
     FROM zk_attendance_scans
     WHERE employee_id = ANY($1::int[]) AND attendance_date BETWEEN $2::date AND $3::date
     GROUP BY 1,2`, empIds, WINDOW_START, WINDOW_END) : [];
  const haveScan = new Set(scanRows.map((r) => `${r.employee_id}|${r.d}`));

  const dailyRows = empIds.length ? await prisma.$queryRawUnsafe<any[]>(
    `SELECT employee_id, date::text AS d, status::text AS status, source::text AS source
     FROM attendance_staff_daily
     WHERE employee_id = ANY($1::int[]) AND date BETWEEN $2::date AND $3::date`, empIds, WINDOW_START, WINDOW_END) : [];
  const daily = new Map(dailyRows.map((r) => [`${r.employee_id}|${r.d}`, r]));

  const mapRows = empIds.length ? await prisma.$queryRawUnsafe<any[]>(
    `SELECT employee_id, device_sn, device_pin, is_active FROM device_user_mappings
     WHERE employee_id = ANY($1::int[])`, empIds) : [];
  const mapsByEmp = new Map<number, any[]>();
  for (const r of mapRows) (mapsByEmp.get(r.employee_id) ?? mapsByEmp.set(r.employee_id, []).get(r.employee_id)!).push(r);

  // For each review row, how many of its device-days each candidate is already
  // covered for — a candidate already covered on every day makes the decision
  // moot, and one covered on none is the likely owner of a real gap.
  for (const a of ambiguous as any[]) {
    const days = [...new Set((merged.get(`${a.device_name}||${a.device_pin.split('/')[0]}`)?.punches ?? []).map((p) => p.date))];
    a.candidate_coverage = a._cands.slice(0, 6).map((c: Candidate) => {
      const covered = days.filter((d) => haveScan.has(`${c.emp.id}|${d}`)).length;
      return `${c.emp.full_name} [${c.emp.id}]: ${covered}/${days.length} days already have punches`;
    }).join(' | ');
    delete a._cands;
  }

  // ── Per-day verdicts ──────────────────────────────────────────────────────
  const perDay: any[] = [];
  const byEmp = new Map<number, any>();
  for (const [, u] of merged) {
    const m = matched.find((x) => x.device_name === u.name && x.device_pin === [...u.pins].join('/'));
    if (!m) continue;
    const days = new Map<string, string[]>();
    for (const p of u.punches) (days.get(p.date) ?? days.set(p.date, []).get(p.date)!).push(p.time);
    const agg = byEmp.get(m.employee_id) ?? { ...m, insert_days: 0, insert_punches: 0, skip_days: 0, skip_punches: 0, holiday_days: 0, device_names: new Set<string>() };
    agg.device_names.add(u.name);
    for (const [d, times] of [...days].sort()) {
      const k = `${m.employee_id}|${d}`;
      const dr = daily.get(k);
      const already = haveScan.has(k);
      const verdict = already ? 'SKIP_HAS_PUNCHES'
        : dr && dr.source === 'SYSTEM' ? 'INSERT_ON_SYSTEM_DAY'
        : dr ? `INSERT_OVER_${dr.source}_${dr.status}`
        : 'INSERT_NEW_DAY';
      if (already) { agg.skip_days++; agg.skip_punches += times.length; }
      else { agg.insert_days++; agg.insert_punches += times.length; if (dr?.source === 'SYSTEM') agg.holiday_days++; }
      perDay.push({ employee_id: m.employee_id, db_name: m.db_name, device_name: u.name,
        device_pin: [...u.pins].join('/'), date: d, punches: times.length, times: times.sort().join(' '),
        times_adjusted: times.sort().map((t) => shift(d, t).time).join(' '),
        existing_daily_status: dr?.status ?? '', existing_daily_source: dr?.source ?? '', verdict });
    }
    byEmp.set(m.employee_id, agg);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const line = (s = '') => console.log(s);
  line('══════════════════════════════════════════════════════════════════');
  line(' OLD-DEVICE ATTENDANCE IMPORT — DRY RUN (nothing written)');
  line('══════════════════════════════════════════════════════════════════');
  line();
  line(`Source files      07Summary.xls (27/07–31/07), 08Summary.xls (01/08–30/08)`);
  line(`Requested window  ${WINDOW_START} .. ${WINDOW_END}`);
  line(`Punches in files  ${punches.length}`);
  line(`  in window       ${kept.length}`);
  line(`  outside window  ${dropped.length}  (${[...new Set(dropped.map((d) => d.date))].sort().join(', ')})`);
  line(`Device users with punches in window: ${[...merged.values()].filter((u) => u.punches.length).length}`);
  line();
  line('── NAME MATCHING ────────────────────────────────────────────────');
  const byTier = (t: string) => matched.filter((m) => m.tier === t).length;
  line(`  matched            ${matched.length}   (EXACT ${byTier('EXACT')}, PREFIX ${byTier('PREFIX')}, TOKENS ${byTier('TOKENS')}, FUZZY ${byTier('FUZZY')})`);
  line(`  AMBIGUOUS — review ${ambiguous.length}`);
  line(`  unmatched          ${unmatched.length}`);
  line();

  const totIns = [...byEmp.values()].reduce((a, b) => a + b.insert_punches, 0);
  const totSkip = [...byEmp.values()].reduce((a, b) => a + b.skip_punches, 0);
  const insDays = [...byEmp.values()].reduce((a, b) => a + b.insert_days, 0);
  const skipDays = [...byEmp.values()].reduce((a, b) => a + b.skip_days, 0);
  const holDays = [...byEmp.values()].reduce((a, b) => a + b.holiday_days, 0);
  line('── WHAT WOULD BE WRITTEN (matched employees only) ───────────────');
  line(`  employees touched      ${byEmp.size}`);
  line(`  punches INSERTED       ${totIns}   across ${insDays} employee-days`);
  line(`  punches SKIPPED        ${totSkip}   across ${skipDays} employee-days (employee already has scans that day)`);
  line(`  of the inserts, ${holDays} land on days currently marked SYSTEM (holiday/auto)`);
  line();

  line('── AMBIGUOUS — NEEDS YOUR REVIEW ────────────────────────────────');
  if (!ambiguous.length) line('  (none)');
  for (const a of ambiguous.sort((x, y) => y.punches - x.punches)) {
    line(`  "${a.device_name}"  pin ${a.device_pin}  ${a.punches} punches / ${a.days} days  [${a.tier}]`);
    line(`      → ${a.candidates}`);
    if (a.candidate_coverage) line(`      coverage: ${a.candidate_coverage}`);
  }
  line();

  line('── UNMATCHED — NO EMPLOYEE FOUND ────────────────────────────────');
  if (!unmatched.length) line('  (none)');
  for (const u of unmatched.sort((x, y) => y.punches - x.punches))
    line(`  "${u.device_name}"  pin ${u.device_pin}  ${u.punches ?? 0} punches / ${u.days ?? 0} days — ${u.reason}`);
  line();

  const lowConf = matched.filter((m) => m.confidence !== 'HIGH').sort((a, b) => b.punches - a.punches);
  line('── MATCHED BUT WORTH A SECOND LOOK (non-exact) ──────────────────');
  if (!lowConf.length) line('  (none)');
  for (const m of lowConf)
    line(`  "${m.device_name}" → ${m.db_name} [id ${m.employee_id}, ${m.status}]  ${m.tier}/${m.confidence}  ${m.punches}p — ${m.why}`);
  line();

  const leftMatched = matched.filter((m) => m.status !== 'ACTIVE' && m.status !== 'PERMANENT');
  line('── MATCHED TO NON-ACTIVE EMPLOYEES ──────────────────────────────');
  if (!leftMatched.length) line('  (none)');
  for (const m of leftMatched) line(`  "${m.device_name}" → ${m.db_name} [id ${m.employee_id}] status=${m.status}  ${m.punches} punches`);
  line();

  const fullySkipped = [...byEmp.values()].filter((e) => e.insert_punches === 0);
  line(`── FULLY SKIPPED (already covered by the live device): ${fullySkipped.length} employees`);
  for (const e of fullySkipped.slice(0, 40)) line(`  ${e.db_name} [${e.employee_id}] — all ${e.skip_punches} punches on ${e.skip_days} days already present`);
  line();

  // Employees with no biometric trace at all in the window — the cohort the
  // old device is supposed to rescue. Anything here still unresolved after the
  // review list is a real, uncovered gap.
  const zeroCovered = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id, e.full_name, e.employee_code, e.employment_status::text AS status
     FROM employee_profiles e
     WHERE e.employment_status NOT IN ('LEFT')
       AND NOT EXISTS (
         SELECT 1 FROM zk_attendance_scans s
         WHERE s.employee_id = e.id AND s.attendance_date BETWEEN $1::date AND $2::date)
     ORDER BY e.full_name`, WINDOW_START, WINDOW_END);
  const touched = new Set(byEmp.keys());
  line(`── EMPLOYEES WITH ZERO BIOMETRIC PUNCHES IN THE WINDOW: ${zeroCovered.length}`);
  for (const z of zeroCovered)
    line(`  ${z.full_name} [${z.id}, ${z.employee_code ?? 'no code'}, ${z.status}]${touched.has(z.id) ? '  ← the old device covers this person' : ''}`);
  line(`  (${zeroCovered.filter((z) => touched.has(z.id)).length} of them are rescued by this import)`);
  line();

  // ── IMPORT PLAN ───────────────────────────────────────────────────────────
  // Everything that clears every filter at once: a name we trust, an active
  // employee, a day with no existing scan, and a day the system is not already
  // calling a holiday. Timestamps carry the clock correction.
  const plan: any[] = [];
  const heldHoliday: any[] = [];
  const heldOther: any[] = [];
  for (const r of perDay) {
    const m = matched.find((x) => x.employee_id === r.employee_id);
    if (!m) continue;
    const reasonHeld =
      r.verdict === 'SKIP_HAS_PUNCHES' ? null
      : m.confidence !== 'HIGH' ? `match is ${m.tier}/${m.confidence}, not confirmed`
      : m.status !== 'ACTIVE' && m.status !== 'PERMANENT' ? `employee is ${m.status}`
      : r.verdict === 'INSERT_ON_SYSTEM_DAY' && !IMPORT_ON_SYSTEM_DAYS ? 'day is currently EXCUSED / SYSTEM'
      : null;
    if (r.verdict === 'SKIP_HAS_PUNCHES') continue;
    if (reasonHeld === 'day is currently EXCUSED / SYSTEM') { heldHoliday.push({ ...r, reason: reasonHeld }); continue; }
    if (reasonHeld) { heldOther.push({ ...r, reason: reasonHeld }); continue; }
    for (const t of String(r.times).split(' ')) {
      const sh = shift(r.date, t);
      plan.push({
        employee_id: r.employee_id, db_name: r.db_name, employee_code: m.employee_code,
        device_pin: r.device_pin, device_name: r.device_name,
        device_time: `${r.date} ${t}`,
        scan_time: `${sh.date} ${sh.time}:00`,
        attendance_date: sh.date,
        crosses_midnight: sh.rolled ? 'YES' : '',
        on_system_day: r.verdict === 'INSERT_ON_SYSTEM_DAY' ? `YES — currently ${r.existing_daily_status}` : '',
        enrolled_today_on: (mapsByEmp.get(r.employee_id) ?? []).map((x: any) => `${x.device_sn}:${x.device_pin}`).join(' | ') || 'NONE',
      });
    }
  }

  const planEmps = [...new Set(plan.map((r) => r.employee_id))];
  line('── IMPORT PLAN (clock-corrected, ready to write) ────────────────');
  line(`  employees   ${planEmps.length}`);
  line(`  punches     ${plan.length}`);
  line(`  days        ${new Set(plan.map((r) => r.employee_id + '|' + r.attendance_date)).size}`);
  line(`  offset      every scan_time = device time + ${CLOCK_OFFSET_MIN} min`);
  line(`  midnight    ${plan.filter((r) => r.crosses_midnight).length} punches roll to the next date`);
  line(`  flagged     ${plan.filter((r) => r.on_system_day).length} punches land on days currently EXCUSED/SYSTEM (marked, imported anyway)`);
  line();
  const planBy = new Map<number, any[]>();
  for (const r of plan) (planBy.get(r.employee_id) ?? planBy.set(r.employee_id, []).get(r.employee_id)!).push(r);
  for (const [id, rs] of [...planBy].sort((a, b) => b[1].length - a[1].length)) {
    const m = matched.find((x) => x.employee_id === id);
    const maps = (mapsByEmp.get(id) ?? []).length;
    line(`  ${rs[0].db_name} [${id}] ${m.employee_code} — ${rs.length} punches / ${new Set(rs.map((r) => r.attendance_date)).size} days` +
         `  pin ${rs[0].device_pin} "${rs[0].device_name}"  ${maps ? 'enrolled' : 'NO MAPPING YET'}`);
  }
  line();
  line(`── STILL HELD ───────────────────────────────────────────────────`);
  if (heldHoliday.length) {
    line(`  ${heldHoliday.reduce((a, r) => a + r.punches, 0)} punches on ${heldHoliday.length} EXCUSED/SYSTEM days`);
    for (const r of heldHoliday) line(`      ${r.date}  ${r.db_name}  ${r.times}`);
  }
  line(`  ${heldOther.reduce((a, r) => a + r.punches, 0)} punches on ${heldOther.length} days held for other reasons:`);
  for (const r of heldOther) line(`      ${r.date}  ${r.db_name}  ${r.times}   (${r.reason})`);
  line();
  for (const sk of skipped) line(`  excluded by decision: "${sk.device_name}" pin ${sk.device_pin} — ${sk.punches} punches / ${sk.days} days`);
  line();
  writeCsv('old-device-import-plan.csv', plan);

  line('── CSVs ─────────────────────────────────────────────────────────');
  writeCsv('old-device-dry-run-matched.csv', matched);
  writeCsv('old-device-dry-run-ambiguous.csv', ambiguous);
  writeCsv('old-device-dry-run-unmatched.csv', unmatched);
  writeCsv('old-device-dry-run-per-day.csv', perDay);
  writeCsv('old-device-dry-run-per-employee.csv', [...byEmp.values()].map((e) => ({
    employee_id: e.employee_id, db_name: e.db_name, employee_code: e.employee_code, status: e.status,
    campus: e.campus, device_pin: e.device_pin, device_names: [...e.device_names].join(' / '),
    tier: e.tier, confidence: e.confidence,
    insert_days: e.insert_days, insert_punches: e.insert_punches,
    skip_days: e.skip_days, skip_punches: e.skip_punches, on_system_days: e.holiday_days,
    existing_mappings: (mapsByEmp.get(e.employee_id) ?? []).map((m: any) => `${m.device_sn}:${m.device_pin}${m.is_active ? '' : ' (inactive)'}`).join(' | '),
  })));

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
