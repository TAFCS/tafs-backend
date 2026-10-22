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

function build(source: AttendanceSource) {
  const svc = Object.create(StaffAttendanceService.prototype) as any;
  const empty = { findMany: jest.fn(async () => []) };
  svc.employeeResolver = { requireByUserId: jest.fn(async () => ({ id: 7, campus_id: null })) };
  svc.prisma = {
    zk_attendance_scans: { findMany: jest.fn(async () => [{ id: 1, attendance_date: day, scan_time: at(2), direction: null }]) },
    attendance_staff_daily: {
      findMany: jest.fn(async () => [{
        date: day, status: StaffAttendanceStatus.PRESENT, source, check_in_at: at(2), check_out_at: at(11, 30),
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
