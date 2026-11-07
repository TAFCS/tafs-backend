import { AttendanceSource, DevicePersonType, StaffAttendanceStatus } from '@prisma/client';
import { HolidayAttendanceSyncService } from './holiday-attendance-sync.service';

// TAFSD-463: a past day that becomes working (a Saturday opened after it
// passed) is rebuilt from that day's punches, so the staff app and the
// attendance modal show it without a manual Recompute Status.

const SATURDAY = new Date(Date.UTC(2026, 9, 31)); // Sat 31 Oct 2026

function build(opts: {
  existing: { source: AttendanceSource; status: StaffAttendanceStatus } | null;
  isWorkingDay: boolean;
  punched: boolean;
}) {
  const processor = {
    recomputeDaySequence: jest.fn(async () => ({ checkInAt: new Date(), checkOutAt: null, lastScanAt: new Date(), scanCount: 1 })),
    upsertStaffDaily: jest.fn(async () => undefined),
    upsertStudentDaily: jest.fn(async () => null),
  };
  const prisma = {
    students: { findMany: jest.fn(async () => []) },
    employee_profiles: {
      findMany: jest.fn(async () => [{
        id: 9, campus_id: 1, department_id: null, staff_category_id: null, days_per_week: 5,
        check_in_source: null, staff_categories: null, employee_work_schedules: [], employee_progression_periods: [],
      }]),
    },
    attendance_staff_daily: {
      findMany: jest.fn(async () => (opts.existing ? [{ employee_id: 9, date: SATURDAY, notes: 'Weekend', ...opts.existing }] : [])),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      upsert: jest.fn(async () => ({})),
    },
    zk_attendance_scans: {
      findMany: jest.fn(async (args: any) =>
        opts.punched && args.where.person_type === DevicePersonType.STAFF ? [{ employee_id: 9 }] : [],
      ),
    },
  };
  const resolver = {
    loadStaffCalendarRows: jest.fn(async () => []),
    loadMandatorySaturdayDatesForEmployees: jest.fn(async () => new Map()),
    loadStaffTimetableContextForEmployees: jest.fn(async () => new Map()),
    resolveStaffDayFromRows: jest.fn(() => ({
      isWorkingDay: opts.isWorkingDay, dayType: opts.isWorkingDay ? 'WORKDAY' : 'WEEKEND', description: 'Weekend', source: 'CALENDAR',
    })),
  };
  const moduleRef = { get: jest.fn(() => processor) };
  const svc = new HolidayAttendanceSyncService(prisma as any, resolver as any, {} as any, moduleRef as any);
  return { svc, processor, prisma };
}

describe('HolidayAttendanceSyncService rebuild on a day that became working', () => {
  it('clears the day-off row and rebuilds the day from the punches', async () => {
    const { svc, processor, prisma } = build({
      existing: { source: AttendanceSource.SYSTEM, status: StaffAttendanceStatus.EXCUSED },
      isWorkingDay: true,
      punched: true,
    });
    const res = await svc.syncCampusForDate(1, SATURDAY, { skipStudents: true });
    expect(prisma.attendance_staff_daily.deleteMany).toHaveBeenCalled();
    expect(processor.recomputeDaySequence).toHaveBeenCalledWith(DevicePersonType.STAFF, 9, null, SATURDAY);
    expect(processor.upsertStaffDaily).toHaveBeenCalledWith(9, SATURDAY, expect.anything());
    expect(res.rebuilt_staff).toBe(1);
  });

  it('rebuilds when the punches never made a row (the day was off when they came in)', async () => {
    const { svc, processor } = build({ existing: null, isWorkingDay: true, punched: true });
    const res = await svc.syncCampusForDate(1, SATURDAY, { skipStudents: true });
    expect(processor.upsertStaffDaily).toHaveBeenCalledTimes(1);
    expect(res.rebuilt_staff).toBe(1);
  });

  it('leaves a day with no punches, and an already-built day, alone', async () => {
    const noPunch = build({ existing: null, isWorkingDay: true, punched: false });
    await noPunch.svc.syncCampusForDate(1, SATURDAY, { skipStudents: true });
    expect(noPunch.processor.upsertStaffDaily).not.toHaveBeenCalled();

    const built = build({
      existing: { source: AttendanceSource.BIOMETRIC, status: StaffAttendanceStatus.PRESENT },
      isWorkingDay: true,
      punched: true,
    });
    await built.svc.syncCampusForDate(1, SATURDAY, { skipStudents: true });
    expect(built.processor.upsertStaffDaily).not.toHaveBeenCalled();
  });

  it('does not rebuild when the caller rebuilds itself (Recompute Status)', async () => {
    const { svc, processor } = build({ existing: null, isWorkingDay: true, punched: true });
    await svc.syncCampusForDate(1, SATURDAY, { skipStudents: true, rebuildFromScans: false });
    expect(processor.upsertStaffDaily).not.toHaveBeenCalled();
  });

  it('does not rebuild a day that is still off', async () => {
    const { svc, processor } = build({ existing: null, isWorkingDay: false, punched: true });
    await svc.syncCampusForDate(1, SATURDAY, { skipStudents: true });
    expect(processor.upsertStaffDaily).not.toHaveBeenCalled();
  });
});
