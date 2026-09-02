/**
 * End-to-end smoke test for the Defaulters report service, through the real
 * Nest DI graph. Exercises all four views, the ARREARS/EXPIRING eligibility
 * split, the scope-enforcement throw, and exports.
 *
 * Run: npx ts-node scripts/smoke-defaulters-report.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { FinancialReportsService } from '../src/modules/financial-reports/financial-reports.service';
import type { IJwtStaffPayload } from '../src/modules/auth/interfaces/jwt-payload.interface';

const superAdmin = {
  sub: 'smoke', username: 'smoke', role: 'SUPER_ADMIN',
  campusId: null, allowedClassIds: [], userType: 'STAFF', permissions: [],
} as unknown as IJwtStaffPayload;

// The six students that motivated the ledger-based eligibility rule — see
// verify-defaulters-vs-compute-arrears.ts for how these were established.
const EXPIRING_CASES = [7291, 7402, 7403, 7720];
const ARREARS_CASE = { cc: 7570, months_behind: 12 };
const EXCLUDED_CASE = 7670;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const svc = app.get(FinancialReportsService);
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures += 1;
  };

  // --- students view, unfiltered (min_months_behind must not exclude EXPIRING) ---
  const t0 = Date.now();
  const students: any = await svc.listDefaulters({ limit: 200 } as any, superAdmin);
  console.log(`\nstudents view: ${students.pagination.total} rows, ${Date.now() - t0}ms`);
  console.log('totals:', JSON.stringify(students.totals, (k, v) =>
    k === 'arrears_distribution' || k === 'months_behind_distribution' ? undefined : v, 1));

  const byCc = new Map<number, any>();
  // Page through everything so the known-case checks below aren't limited to page 1.
  {
    let page = 1;
    for (;;) {
      const res: any = await svc.listDefaulters({ page, limit: 200 } as any, superAdmin);
      for (const r of res.items) byCc.set(r.cc, r);
      if (page >= res.pagination.pages) break;
      page += 1;
    }
  }
  console.log(`fetched all ${byCc.size} rows across pagination`);

  for (const cc of EXPIRING_CASES) {
    const row = byCc.get(cc);
    check(`cc=${cc} present as EXPIRING`, !!row && row.category === 'EXPIRING' && row.months_behind === 0 && row.severity === 'EXPIRING',
      row ? `category=${row.category} months=${row.months_behind} severity=${row.severity}` : 'missing');
  }
  {
    const row = byCc.get(ARREARS_CASE.cc);
    check(`cc=${ARREARS_CASE.cc} present as ARREARS with months_behind=${ARREARS_CASE.months_behind}`,
      !!row && row.category === 'ARREARS' && row.months_behind === ARREARS_CASE.months_behind,
      row ? `category=${row.category} months=${row.months_behind}` : 'missing');
  }
  check(`cc=${EXCLUDED_CASE} absent entirely`, !byCc.has(EXCLUDED_CASE));

  check('every row has category ARREARS or EXPIRING',
    students.items.every((r: any) => r.category === 'ARREARS' || r.category === 'EXPIRING'));
  check('EXPIRING rows always months_behind=0 and severity=EXPIRING',
    students.items.filter((r: any) => r.category === 'EXPIRING')
      .every((r: any) => r.months_behind === 0 && r.severity === 'EXPIRING'));
  check('ARREARS severity matches months_behind',
    students.items.filter((r: any) => r.category === 'ARREARS').every((r: any) =>
      (r.months_behind === 1 && r.severity === 'WATCH') ||
      (r.months_behind === 2 && r.severity === 'DEFAULTER') ||
      (r.months_behind === 3 && r.severity === 'SEVERE') ||
      (r.months_behind >= 4 && r.severity === 'CRITICAL')));
  check('lps_projected === months_behind * 1000',
    students.items.every((r: any) => r.lps_projected_next_voucher === r.months_behind * 1000));
  check('sorted worst-first (default sort)',
    students.items.every((r: any, i: number) => i === 0 || students.items[i - 1].months_behind >= r.months_behind));

  const worst = [...byCc.values()].sort((a, b) => b.months_behind - a.months_behind)[0];
  console.log('\nworst row:', {
    cc: worst?.cc, name: worst?.student_name, category: worst?.category,
    severity: worst?.severity, months_behind: worst?.months_behind,
    arrears: worst?.arrears_outstanding, oldest: worst?.oldest_arrear_fee_date,
    oldest_label: worst?.oldest_arrear_month_label,
    lps_charged: worst?.lps_charged, lps_out: worst?.lps_outstanding,
    in_window: worst?.arrear_months_in_window, outside_window: worst?.arrear_months_outside_window,
  });
  console.log('strip:', worst?.strip.map((c: any) =>
    `${c.month}/${String(c.year).slice(2)}:${c.state}${c.is_arrear ? '*' : ''}`).join(' '));

  // Red cells drawn + reported "outside window" must always account for the
  // full months_behind -- the strip must never silently show fewer arrears
  // than the headline number without saying why.
  let stripAccounted = 0;
  for (const r of byCc.values()) {
    const drawn = r.strip.filter((c: any) => c.is_arrear).length;
    const drawnGroups = new Set<string>();
    for (const c of r.strip) if (c.is_arrear) for (const k of c.group_keys) drawnGroups.add(k);
    if (drawnGroups.size === r.arrear_months_in_window &&
        r.arrear_months_in_window + r.arrear_months_outside_window === r.months_behind) {
      stripAccounted += 1;
    } else {
      console.log(`  strip drift cc=${r.cc}: drawn=${drawnGroups.size} in_window=${r.arrear_months_in_window} outside=${r.arrear_months_outside_window} months_behind=${r.months_behind}`);
    }
  }
  check(`strip accounts for every arrear month (${stripAccounted}/${byCc.size})`, stripAccounted === byCc.size);

  const expiringExample = byCc.get(EXPIRING_CASES[0]);
  console.log('\nEXPIRING example strip (cc=' + EXPIRING_CASES[0] + '):', expiringExample?.strip.map((c: any) =>
    `${c.month}/${String(c.year).slice(2)}:${c.state}${c.is_arrear ? '*' : ''}`).join(' '));
  check('EXPIRING example has zero red (is_arrear) cells',
    expiringExample?.strip.every((c: any) => !c.is_arrear));

  // --- min_months_behind must not filter out EXPIRING rows ---
  const narrowed: any = await svc.listDefaulters({ min_months_behind: 3, limit: 200 } as any, superAdmin);
  check('min_months_behind=3 keeps EXPIRING rows, drops WATCH/DEFAULTER',
    narrowed.items.every((r: any) => r.category === 'EXPIRING' || r.months_behind >= 3));

  // --- severity filter ---
  const crit: any = await svc.listDefaulters({ severity: ['CRITICAL'] } as any, superAdmin);
  check('severity=CRITICAL filter matches totals.critical_count',
    crit.totals.defaulter_count === students.totals.critical_count,
    `${crit.totals.defaulter_count} vs ${students.totals.critical_count}`);
  check('severity filter keeps in_scope denominator',
    crit.totals.in_scope_students === students.totals.in_scope_students);

  const expiringOnly: any = await svc.listDefaulters({ severity: ['EXPIRING'] } as any, superAdmin);
  check('severity=EXPIRING filter matches totals.expiring_count',
    expiringOnly.totals.defaulter_count === students.totals.expiring_count);

  // --- rollups ---
  const byClass: any = await svc.listDefaulters({ view: 'by_class', limit: 5 } as any, superAdmin);
  console.log('\nby_class (top 5):');
  for (const r of byClass.items) {
    console.log(`  ${String(r.class_name).padEnd(22)} ${String(r.defaulter_count).padStart(4)}/${String(r.in_scope_students).padEnd(5)} ${String(r.defaulter_rate).padStart(5)}%  arrears ${r.arrears_outstanding}`);
  }
  const byCampus: any = await svc.listDefaulters({ view: 'by_campus' } as any, superAdmin);
  const aging: any = await svc.listDefaulters({ view: 'aging' } as any, superAdmin);
  console.log('\naging:');
  for (const r of aging.items) {
    console.log(`  ${String(r.label).padEnd(10)} ${String(r.months_behind_label).padStart(3)}m  ${String(r.student_count).padStart(4)} students  ${String(r.share_of_defaulters).padStart(5)}%  arrears ${r.arrears_outstanding}  lps ${r.lps_projected}`);
  }
  check('aging always emits 5 bands (incl. EXPIRING)', aging.items.length === 5);
  check('aging student_count sums to defaulter_count',
    aging.items.reduce((a: number, r: any) => a + r.student_count, 0) === aging.totals.defaulter_count);
  check('by_campus defaulter_count sums to total',
    byCampus.items.reduce((a: number, r: any) => a + r.defaulter_count, 0) === byCampus.totals.defaulter_count);
  check('by_class band_counts include EXPIRING key',
    byClass.items.every((r: any) => typeof r.band_counts.EXPIRING === 'number'));

  // --- scope enforcement must throw, not filter-to-empty ---
  const campusScoped = { ...superAdmin, campusId: 1 } as IJwtStaffPayload;
  let threw = false;
  try {
    await svc.listDefaulters({ campus_id: [999] } as any, campusScoped);
  } catch (e: any) {
    threw = e?.status === 403 || /access to this campus/i.test(e?.message ?? '');
  }
  check('out-of-scope campus throws 403', threw);

  // --- exports ---
  for (const view of ['students', 'by_class', 'by_campus', 'aging'] as const) {
    for (const format of ['xlsx', 'csv'] as const) {
      const file = await svc.exportDefaulters({ view, format } as any, superAdmin);
      check(`export ${view}/${format}`, file.buffer.length > 0, `${file.filename} ${file.buffer.length}b`);
    }
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
  await app.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
