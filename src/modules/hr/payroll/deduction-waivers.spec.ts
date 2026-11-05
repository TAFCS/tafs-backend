import { Prisma } from '@prisma/client';
import { PayrollService } from './payroll.service';
import {
  applyDeductionWaiverChange,
  normalizeDeductionWaivers,
  NO_DEDUCTION_WAIVERS,
} from './deduction-waivers.util';

// TAFSD-471/472: switch attendance deductions off on one run, by type or by day.

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
const at = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00Z`);

function build(workingDays: Set<string>) {
  const svc = Object.create(PayrollService.prototype) as any;
  svc.expectedTimes = {
    resolveExpectedTimes: jest.fn(async () => ({
      expectedCheckIn: T('08:00'),
      expectedCheckOut: T('16:00'),
      graceMinutes: 0,
    })),
  };
  svc.calendarResolver = {
    resolveStaffDayFromRows: (_rows: unknown, d: Date) =>
      workingDays.has(d.toISOString().slice(0, 10))
        ? {
            isWorkingDay: true,
            dayType: null,
            description: null,
            source: 'SCHEDULE',
          }
        : {
            isWorkingDay: false,
            dayType: 'WEEKEND',
            description: 'Weekend',
            source: 'SCHEDULE',
          },
  };
  svc.payrollRules = { findEffective: jest.fn(async () => null) };
  return svc;
}

const employee = {
  id: 9,
  monthly_pay: new Prisma.Decimal(31000),
  reporting_time: null,
  leaving_time: null,
  late_relaxation_minutes: null,
  department_id: 1,
  staff_category_id: 1,
  staff_categories: { code: 'T' },
  days_per_week: 5,
  employee_work_schedules: [],
  check_in_source: 'FIXED',
  join_date: D('2020-01-01'),
  date_of_leaving: null,
};
const scan = (iso: string, hhmm: string) => ({
  employee_id: 9,
  attendance_date: D(iso),
  scan_time: at(iso, hhmm),
  device_sn: 'X',
});
const range: string[] = [];
for (
  let d = D('2026-10-01');
  d <= D('2026-10-31');
  d = new Date(d.getTime() + 86_400_000)
)
  range.push(d.toISOString().slice(0, 10));

// 3 Oct absent; 7 Oct left 45 min early; 9 Oct left 30 min early; the rest full days.
const scans = range.flatMap((d) => {
  if (d === '2026-10-03') return [];
  const out =
    d === '2026-10-07' ? '15:15' : d === '2026-10-09' ? '15:30' : '16:00';
  return [scan(d, '08:00'), scan(d, out)];
});
const perMinute = 1000 / 480;

const line = (deductions = NO_DEDUCTION_WAIVERS) =>
  build(new Set(range)).computeEmployeeLine(
    employee,
    1,
    D('2026-10-01'),
    D('2026-10-31'),
    [],
    [],
    scans,
    true,
    undefined,
    undefined,
    false,
    undefined,
    {
      eobi: false,
      sessi: false,
      income_tax: false,
      deductions,
    },
  );

describe('TAFSD-471/472: deduction waivers', () => {
  it('deducts everything when nothing is switched off', async () => {
    const l = await line();
    expect(Number(l.absence_deduction)).toBeCloseTo(1000, 2);
    expect(Number(l.early_leave_deduction)).toBeCloseTo(perMinute * 75, 2);
  });

  it('a type switched off for the cycle is not deducted at all; the others still are', async () => {
    const l = await line(normalizeDeductionWaivers({ types: ['EARLY_LEAVE'] }));
    expect(Number(l.early_leave_deduction)).toBe(0);
    expect(Number(l.absence_deduction)).toBeCloseTo(1000, 2);
    expect(l.deduction_waivers.types).toEqual(['EARLY_LEAVE']);
  });

  it('one day switched off lets off only that day, and the day is marked', async () => {
    const w = applyDeductionWaiverChange(NO_DEDUCTION_WAIVERS, {
      date: '2026-10-07',
      day_kinds: ['EARLY_LEAVE'],
      reason: 'Doctor',
    });
    const l = await line(w);
    expect(Number(l.early_leave_deduction)).toBeCloseTo(perMinute * 30, 2);
    const day = l.daily_breakdown.find((d: any) => d.date === '2026-10-07');
    expect(day.waived_deductions).toEqual(['EARLY_LEAVE']);
    expect(day.waiver_reason).toBe('Doctor');
    // The attendance facts stay as they are.
    expect(day.early_leave_minutes).toBe(45);
  });

  it('an absence let off for a day is paid', async () => {
    const l = await line(
      applyDeductionWaiverChange(NO_DEDUCTION_WAIVERS, {
        date: '2026-10-03',
        day_kinds: ['ABSENCE'],
      }),
    );
    expect(Number(l.absence_deduction)).toBe(0);
    expect(l.absent_days).toBe(1);
  });

  it('changes replace the cycle set or one day, and an empty day clears it', () => {
    let w = applyDeductionWaiverChange(NO_DEDUCTION_WAIVERS, {
      types: ['LATE', 'BREAK', 'LATE'],
    });
    w = applyDeductionWaiverChange(w, {
      date: '2026-10-07',
      day_kinds: ['EARLY_LEAVE'],
      reason: 'Doctor',
    });
    expect(w).toEqual({
      types: ['LATE', 'BREAK'],
      days: { '2026-10-07': ['EARLY_LEAVE'] },
      reasons: { '2026-10-07': 'Doctor' },
    });
    w = applyDeductionWaiverChange(w, { date: '2026-10-07', day_kinds: [] });
    expect(w).toEqual({ types: ['LATE', 'BREAK'], days: {}, reasons: {} });
    expect(
      normalizeDeductionWaivers({ types: ['NOPE'], days: { bad: ['LATE'] } }),
    ).toEqual(NO_DEDUCTION_WAIVERS);
  });
});

jest.mock('../../../common/auth/super-admin', () => ({
  ...jest.requireActual('../../../common/auth/super-admin'),
  assertMayChangeEmployee: jest.fn(async () => undefined),
}));

describe('TAFSD-471/472: setDeductionWaivers', () => {
  function svcWith(stored: unknown) {
    const svc = Object.create(PayrollService.prototype) as any;
    svc.prisma = {
      payroll_run_lines: {
        findUnique: jest.fn(async () => ({ deduction_waivers: stored })),
      },
      payroll_runs: {
        findUnique: jest.fn(async () => ({
          period_start: D('2026-09-26'),
          period_end: D('2026-10-25'),
        })),
      },
    };
    svc.regenerateLine = jest.fn(async () => ({ id: 79 }));
    svc.auditLogs = { log: jest.fn() };
    return svc;
  }
  const user = { sub: 'u1', role: 'SUPER_ADMIN' } as any;

  it('merges the change into what is stored and regenerates with it', async () => {
    const svc = svcWith({ types: ['BREAK'] });
    await svc.setDeductionWaivers(
      79,
      5,
      { date: '2026-10-14', day_kinds: ['LATE'] },
      user,
    );
    expect(svc.regenerateLine.mock.calls[0][4]).toEqual({
      deductions: {
        types: ['BREAK'],
        days: { '2026-10-14': ['LATE'] },
        reasons: {},
      },
    });
    expect(svc.auditLogs.log.mock.calls[0][0].note).toContain(
      'Late arrival off on 2026-10-14',
    );
  });

  it('refuses a day outside the cycle', async () => {
    await expect(
      svcWith({}).setDeductionWaivers(
        79,
        5,
        { date: '2026-10-30', day_kinds: ['LATE'] },
        user,
      ),
    ).rejects.toThrow(/not in this payroll cycle/);
  });
});
