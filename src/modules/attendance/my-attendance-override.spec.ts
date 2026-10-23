import { AttendanceSource, StaffAttendanceStatus } from '@prisma/client';
import { StaffAttendanceService } from './staff-attendance.service';
import { computePayrollWindow, currentPayrollPeriodLabel, parsePayrollPeriod } from '../hr/payroll/payroll-period.util';

// TAFSD-401: an overridden day must not hand the staff app its raw punches,
// which it would read as "Needs review / missing clock-out".

const period = currentPayrollPeriodLabel();
const { year, month } = parsePayrollPeriod(period);
const { periodStart } = computePayrollWindow(year, month);
const day = new Date(periodStart);
const at = (h: number, m = 0) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));

function build(source: AttendanceSource, status: StaffAttendanceStatus = StaffAttendanceStatus.PRESENT, scans = true) {
  const svc = Object.create(StaffAttendanceService.prototype) as any;
  const empty = { findMany: jest.fn(async () => []) };
  svc.employeeResolver = { requireByUserId: jest.fn(async () => ({ id: 7, campus_id: null })) };
  svc.prisma = {
    zk_attendance_scans: { findMany: jest.fn(async () => (scans ? [{ id: 1, attendance_date: day, scan_time: at(2), direction: null }] : [])) },
    attendance_staff_daily: {
      findMany: jest.fn(async () => [{
        date: day, status, source, check_in_at: at(2), check_out_at: at(11, 30),
        expected_check_in_snapshot: null, expected_check_out_snapshot: null, expected_time_source_snapshot: null,
      }]),
    },
    attendance_objections: empty,
    payroll_run_lines: { findFirst: jest.fn(async () => null) },
    employee_profiles: { findUnique: jest.fn(async () => ({ days_per_week: 5, employee_work_schedules: [], check_in_source: null, join_date: null, date_of_leaving: null })) },
    employee_progression_periods: empty,
  };
  return svc;
}

const first = async (source: AttendanceSource) => {
  const res = await build(source).getMyAttendance('u7', { period });
  return res.days.find((d: any) => d.date === day.toISOString().slice(0, 10));
};

describe('getMyAttendance on an overridden day', () => {
  it('sends the override times as clock events, keeps punches in raw_scans, and flags the override', async () => {
    const d = await first(AttendanceSource.MANUAL);
    expect(d.is_manual_override).toBe(true);
    // TAFSD-413: an even in/out pair, not an empty list ("No scans recorded").
    expect(d.scans).toEqual([
      { id: -1, scan_time: at(2).toISOString(), direction: 'IN' },
      { id: -2, scan_time: at(11, 30).toISOString(), direction: 'OUT' },
    ]);
    expect(d.raw_scans).toHaveLength(1);
    expect(d.check_out_at).toBe(at(11, 30).toISOString());
    expect(d.status).toBe(StaffAttendanceStatus.PRESENT);
  });

  it('leaves a device-sourced day as it was', async () => {
    const d = await first(AttendanceSource.BIOMETRIC);
    expect(d.is_manual_override).toBe(false);
    expect(d.scans).toHaveLength(1);
  });
});

// TAFSD-414: the app reads only EXCUSED as leave; CASUAL_LEAVE with no scans showed Absent.
describe('getMyAttendance on an approved leave day', () => {
  it('sends paid leave as EXCUSED', async () => {
    for (const status of [StaffAttendanceStatus.CASUAL_LEAVE, StaffAttendanceStatus.SICK_LEAVE, StaffAttendanceStatus.ANNUAL_LEAVE]) {
      const res = await build(AttendanceSource.LEAVE, status, false).getMyAttendance('u7', { period });
      const d = res.days.find((x: any) => x.date === day.toISOString().slice(0, 10));
      expect(d.status).toBe(StaffAttendanceStatus.EXCUSED);
    }
  });

  it('leaves unpaid leave as it is', async () => {
    const res = await build(AttendanceSource.LEAVE, StaffAttendanceStatus.UNPAID_LEAVE, false).getMyAttendance('u7', { period });
    const d = res.days.find((x: any) => x.date === day.toISOString().slice(0, 10));
    expect(d.status).toBe(StaffAttendanceStatus.UNPAID_LEAVE);
  });

  it('maps the payroll breakdown classification too', async () => {
    const svc = build(AttendanceSource.LEAVE, StaffAttendanceStatus.CASUAL_LEAVE, false);
    svc.prisma.payroll_run_lines.findFirst = jest.fn(async () => ({
      payroll_runs: { status: 'FINALIZED' }, disbursed_at: null, disbursement_notes: null, daily_rate: 1, per_minute_rate: 1,
      daily_breakdown: [{ date: '2026-10-17', classification: 'CASUAL_LEAVE' }, { date: '2026-10-18', classification: 'ABSENT' }],
    }));
    const res = await svc.getMyAttendance('u7', { period });
    expect(res.payroll_snapshot.daily_breakdown.map((d: any) => d.classification)).toEqual(['EXCUSED', 'ABSENT']);
  });
});
