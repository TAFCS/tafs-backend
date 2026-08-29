/**
 * End-to-end smoke test for the Defaulters report service, through the real
 * Nest DI graph. Exercises all four views plus the scope-enforcement throw.
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

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const svc = app.get(FinancialReportsService);
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures += 1;
  };

  // --- students view ---
  const t0 = Date.now();
  const students: any = await svc.listDefaulters({ limit: 10 } as any, superAdmin);
  console.log(`\nstudents view: ${students.pagination.total} defaulters, ${Date.now() - t0}ms`);
  console.log('totals:', JSON.stringify(students.totals, (k, v) =>
    k === 'arrears_distribution' || k === 'months_behind_distribution' ? undefined : v, 1));
  const worst = students.items[0];
  console.log('\ntop row:', {
    cc: worst?.cc, name: worst?.student_name, class: worst?.class_name,
    severity: worst?.severity, months_behind: worst?.months_behind,
    unbilled: worst?.months_behind_unbilled,
    arrears: worst?.arrears_outstanding, oldest: worst?.oldest_arrear_fee_date,
    oldest_label: worst?.oldest_arrear_month_label,
    lps_charged: worst?.lps_charged, lps_out: worst?.lps_outstanding,
    lps_next: worst?.lps_projected_next_voucher,
    unreleased: worst?.unreleased_voucher_count,
    last_payment: worst?.last_payment_date, days_since: worst?.days_since_last_payment,
  });
  console.log('strip:', worst?.strip.map((c: any) =>
    `${c.month}/${String(c.year).slice(2)}:${c.state}${c.is_arrear ? '*' : ''}`).join(' '));

  check('columns match strip length',
    students.columns.length === 12 && worst?.strip.length === 12,
    `cols=${students.columns.length} strip=${worst?.strip.length}`);
  check('sorted worst-first',
    students.items.every((r: any, i: number) => i === 0 || students.items[i - 1].months_behind >= r.months_behind));
  check('severity matches months_behind',
    students.items.every((r: any) =>
      (r.months_behind === 1 && r.severity === 'WATCH') ||
      (r.months_behind === 2 && r.severity === 'DEFAULTER') ||
      (r.months_behind === 3 && r.severity === 'SEVERE') ||
      (r.months_behind >= 4 && r.severity === 'CRITICAL')));
  check('billed + unbilled === months_behind',
    students.items.every((r: any) => r.months_behind_billed + r.months_behind_unbilled === r.months_behind));
  check('lps_projected === months_behind * 1000',
    students.items.every((r: any) => r.lps_projected_next_voucher === r.months_behind * 1000));

  // The strip must account for every arrear month: the ones it can draw, plus
  // the ones that fall outside the backward-looking window (a whole year billed
  // on one fee_date carries target months ahead of today).
  let stripOk = 0;
  for (const r of students.items) {
    const groups = new Set<string>();
    for (const cell of r.strip) for (const k of cell.group_keys) groups.add(k);
    const accounted =
      groups.size === r.arrear_months_in_window &&
      r.arrear_months_in_window + r.arrear_months_outside_window === r.months_behind;
    if (accounted) stripOk += 1;
    else console.log(`  strip drift cc=${r.cc}: drawn=${groups.size} in_window=${r.arrear_months_in_window} outside=${r.arrear_months_outside_window} months_behind=${r.months_behind}`);
  }
  check(`strip accounts for every arrear month (${stripOk}/${students.items.length})`,
    stripOk === students.items.length);
  console.log(`  rows with arrears outside the window: ${students.items.filter((r: any) => r.arrear_months_outside_window > 0).length}/${students.items.length}`);

  // --- severity filter narrows totals but not the denominator ---
  const crit: any = await svc.listDefaulters({ severity: ['CRITICAL'] } as any, superAdmin);
  check('severity filter narrows defaulter_count',
    crit.totals.defaulter_count === students.totals.critical_count,
    `${crit.totals.defaulter_count} vs ${students.totals.critical_count}`);
  check('severity filter keeps in_scope denominator',
    crit.totals.in_scope_students === students.totals.in_scope_students);

  // --- rollups ---
  const byClass: any = await svc.listDefaulters({ view: 'by_class', limit: 5 } as any, superAdmin);
  console.log('\nby_class (top 5):');
  for (const r of byClass.items) {
    console.log(`  ${String(r.class_name).padEnd(22)} ${String(r.defaulter_count).padStart(4)}/${String(r.in_scope_students).padEnd(5)} ${String(r.defaulter_rate).padStart(5)}%  arrears ${r.arrears_outstanding}`);
  }
  const byCampus: any = await svc.listDefaulters({ view: 'by_campus' } as any, superAdmin);
  console.log('\nby_campus:');
  for (const r of byCampus.items) {
    console.log(`  ${String(r.campus).padEnd(22)} ${String(r.defaulter_count).padStart(4)}/${String(r.in_scope_students).padEnd(5)} ${String(r.defaulter_rate).padStart(5)}%`);
  }
  const aging: any = await svc.listDefaulters({ view: 'aging' } as any, superAdmin);
  console.log('\naging:');
  for (const r of aging.items) {
    console.log(`  ${String(r.label).padEnd(10)} ${String(r.months_behind_label).padStart(3)}m  ${String(r.student_count).padStart(4)} students  ${String(r.share_of_defaulters).padStart(5)}%  arrears ${r.arrears_outstanding}  lps ${r.lps_projected}`);
  }
  check('aging always emits 4 bands', aging.items.length === 4);
  check('aging student_count sums to defaulter_count',
    aging.items.reduce((a: number, r: any) => a + r.student_count, 0) === aging.totals.defaulter_count);
  check('by_campus defaulter_count sums to total',
    byCampus.items.reduce((a: number, r: any) => a + r.defaulter_count, 0) === byCampus.totals.defaulter_count);

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
  // The export must carry EVERY defaulter, not one page of them. The service's
  // page-size clamp silently truncated this to 200 rows until exportDefaulters
  // was given an explicit maxLimit.
  const csv = await svc.exportDefaulters({ view: 'students', format: 'csv' } as any, superAdmin);
  const dataRows = csv.buffer.toString('utf8').trim().split('\n').length - 1;
  check('export includes every defaulter, not one page',
    dataRows === students.totals.defaulter_count,
    `csv rows=${dataRows} defaulters=${students.totals.defaulter_count}`);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
  await app.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
