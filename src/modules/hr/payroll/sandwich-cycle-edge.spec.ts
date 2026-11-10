import { Prisma } from '@prisma/client';

// TAFSD-500 (Mirza, item 48): someone absent the whole cycle still got a few
// days' pay when the cycle started or ended on a weekend, because the working
// day that sandwiches that weekend sits in the previous or next cycle. The
// sandwich rule now looks just past the cycle's edges.

let today = '2026-11-10';
jest.mock('../employees/employee-timings.service', () => ({
  ...jest.requireActual('../employees/employee-timings.service'),
  todayPkt: () => today,
}));
// eslint-disable-next-line import/first
import { PayrollService } from './payroll.service';

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
const at = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00Z`);

/** Mon–Fri working, Sat/Sun weekend. */
const isWeekday = (d: Date) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;

function build() {
  const svc = Object.create(PayrollService.prototype) as any;
  svc.expectedTimes = {
    resolveExpectedTimes: jest.fn(async () => ({ expectedCheckIn: T('08:00'), expectedCheckOut: T('16:00'), graceMinutes: 0 })),
  };
  svc.calendarResolver = {
    resolveStaffDayFromRows: (_rows: unknown, d: Date) =>
      isWeekday(d)
        ? { isWorkingDay: true, dayType: null, description: null, source: 'SCHEDULE' }
        : { isWorkingDay: false, dayType: 'WEEKEND', description: 'Weekend', source: 'SCHEDULE' },
  };
  svc.payrollRules = { findEffective: jest.fn(async () => null) };
  return svc;
}

const employee = {
  id: 9, monthly_pay: new Prisma.Decimal(30000), reporting_time: null, leaving_time: null, late_relaxation_minutes: null,
  department_id: 1, staff_category_id: 1, staff_categories: { code: 'T' }, days_per_week: 5, employee_work_schedules: [],
  check_in_source: 'FIXED', join_date: D('2020-01-01'), date_of_leaving: null,
};
const scan = (iso: string, hhmm: string) => ({ employee_id: 9, attendance_date: D(iso), scan_time: at(iso, hhmm), device_sn: 'X' });
const worked = (iso: string) => [scan(iso, '08:00'), scan(iso, '16:00')];

// The OCT 2026 cycle: Sat 26 Sep – Sun 25 Oct. It opens and closes on a weekend.
const START = D('2026-09-26');
const END = D('2026-10-25');

async function flagsFor(scans: ReturnType<typeof scan>[], emp: object = employee) {
  const svc = build();
  const line = await svc.computeEmployeeLine(emp, 1, START, END, [], [], scans, true);
  return { line, flags: svc.detectFlagsForLine(line) as { dates: string[] }[] };
}
const flagged = (flags: { dates: string[] }[]) => flags.flatMap((f) => f.dates).sort();

describe('sandwich rule at the cycle edges', () => {
  beforeEach(() => {
    today = '2026-11-10';
  });

  it('absent all cycle, and on the Friday before and the Monday after: every weekend is sandwiched', async () => {
    const { flags } = await flagsFor([]);
    const dates = flagged(flags);
    expect(dates).toEqual(expect.arrayContaining(['2026-09-26', '2026-09-27', '2026-10-24', '2026-10-25']));
    // 5 weekends × 2 days, all of them.
    expect(dates).toHaveLength(10);
  });

  it('worked the Friday before the cycle: the opening weekend stays paid', async () => {
    const { flags, line } = await flagsFor(worked('2026-09-25'));
    expect(flagged(flags)).not.toContain('2026-09-26');
    expect(flagged(flags)).toContain('2026-10-25');
    expect(line.daily_breakdown[0].prev_working_day).toMatchObject({ date: '2026-09-25', classification: 'PRESENT' });
    // A punch outside the cycle doesn't count as a punch in it.
    expect(line.has_punches).toBe(false);
  });

  it('worked the Monday after the cycle: the closing weekend stays paid', async () => {
    const { flags, line } = await flagsFor(worked('2026-10-26'));
    expect(flagged(flags)).toContain('2026-09-26');
    expect(flagged(flags)).not.toContain('2026-10-25');
    expect(line.daily_breakdown.at(-1).next_working_day).toMatchObject({ date: '2026-10-26', classification: 'PRESENT' });
  });

  it("doesn't judge by a Monday that hasn't happened yet", async () => {
    today = '2026-10-26';
    const { flags, line } = await flagsFor([]);
    expect(flagged(flags)).not.toContain('2026-10-25');
    expect(line.daily_breakdown.at(-1).next_working_day).toBeNull();
  });

  it("doesn't look before a joining date", async () => {
    const { flags } = await flagsFor([], { ...employee, join_date: D('2026-09-26') });
    expect(flagged(flags)).not.toContain('2026-09-26');
  });

  it('a cycle that opens on a working day is unchanged', async () => {
    const svc = build();
    const line = await svc.computeEmployeeLine(employee, 1, D('2026-09-28'), D('2026-10-23'), [], [], [], true);
    expect(line.daily_breakdown[0].prev_working_day).toBeUndefined();
    expect(line.daily_breakdown.at(-1).next_working_day).toBeUndefined();
  });
});
