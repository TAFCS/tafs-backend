import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { attendance_staff_daily, AttendanceSource, StaffAttendanceStatus, zk_attendance_scans } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { CalendarDayResolverService } from '../hr/calendar/calendar-day-resolver.service';
import { HolidayAttendanceSyncService } from '../hr/calendar/holiday-attendance-sync.service';
import {
  BulkMarkStaffAttendanceDto,
  GetMyStaffAttendanceQueryDto,
  GetStaffAttendanceQueryDto,
  GetStaffTimelineQueryDto,
} from './dto/staff-attendance.dto';
import { EmployeeProfileResolverService } from '../hr/employee-profile-resolver.service';
import { EmployeeExpectedTimesService } from '../timetables/employee-expected-times.service';
import {
  computePayrollWindow,
  currentPayrollPeriodLabel,
  parsePayrollPeriod,
} from '../hr/payroll/payroll-period.util';
import type { DayBreakdownEntry } from '../hr/payroll/payroll.service';

@Injectable()
export class StaffAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly holidaySync: HolidayAttendanceSyncService,
    private readonly employeeResolver: EmployeeProfileResolverService,
    private readonly expectedTimes: EmployeeExpectedTimesService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private parseDate(dateStr: string): Date {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private assertCampusAccess(user: IJwtStaffPayload, campusId: number) {
    if (user.campusId && user.campusId !== campusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }
  }

  async getRegister(query: GetStaffAttendanceQueryDto, user: IJwtStaffPayload) {
    const date = this.parseDate(query.date);

    // Determine effective campus: caller-scoped or explicit
    const campusId = query.campus_id ?? user.campusId ?? undefined;
    if (!campusId) throw new BadRequestException('campus_id is required');
    this.assertCampusAccess(user, campusId);

    await this.holidaySync.syncCampusForDate(campusId, date);

    // Fetch employees whose linked user belongs to this campus
    const employees = await this.prisma.employee_profiles.findMany({
      where: {
        users: { campus_id: campusId, is_active: true, deleted_at: null },
        ...(query.department_id ? { department_id: query.department_id } : {}),
      },
      include: {
        users: { select: { id: true, full_name: true, role: true, email: true } },
        departments: { select: { id: true, name: true } },
        designations: { select: { id: true, title: true } },
      },
      orderBy: [{ departments: { name: 'asc' } }, { id: 'asc' }],
    });

    if (employees.length === 0) return [];

    // Fetch existing attendance records for the date
    const employeeIds = employees.map((e) => e.id);
    const records = await this.prisma.attendance_staff_daily.findMany({
      where: { date, employee_id: { in: employeeIds } },
    });

    const recordMap = new Map(records.map((r) => [r.employee_id, r]));

    const rows = await Promise.all(
      employees.map(async (emp) => {
        const resolved = await this.calendarResolver.resolveStaffDay(emp.id, campusId, date);
        return {
          employee: emp,
          record: recordMap.get(emp.id) ?? null,
          is_working_day: resolved.isWorkingDay,
          day_type: resolved.dayType,
          day_description: resolved.description,
        };
      }),
    );

    return rows;
  }

  // Shared employee scope lookup for the summary/dashboard endpoints — same
  // campus + department filtering as getRegister().
  private async getEmployeesInScope(campusId: number, departmentId?: number) {
    return this.prisma.employee_profiles.findMany({
      where: {
        users: { campus_id: campusId, is_active: true, deleted_at: null },
        ...(departmentId ? { department_id: departmentId } : {}),
      },
      include: {
        users: { select: { id: true, full_name: true, role: true, email: true } },
        departments: { select: { id: true, name: true } },
        designations: { select: { id: true, title: true } },
        campuses: { select: { id: true, campus_name: true } },
      },
      orderBy: [{ departments: { name: 'asc' } }, { id: 'asc' }],
    });
  }

  // Classifies a check-in time relative to the employee's reporting time
  // (± late_relaxation_minutes): before reporting time = early, within
  // relaxation = on_time, after = late. Independent of the persisted
  // attendance_staff_daily.status (PRESENT/LATE), which only distinguishes
  // on_time vs late.
  private classifyCheckIn(
    checkInAt: Date,
    reportingTime: Date | null,
    lateRelaxationMinutes: number | null,
  ): 'on_time' | 'late' | 'early' {
    if (!reportingTime) return 'on_time';
    const reportingMinutes = reportingTime.getUTCHours() * 60 + reportingTime.getUTCMinutes();
    const checkInMinutes = checkInAt.getUTCHours() * 60 + checkInAt.getUTCMinutes();
    const relaxation = lateRelaxationMinutes ?? 0;
    if (checkInMinutes < reportingMinutes) return 'early';
    if (checkInMinutes <= reportingMinutes + relaxation) return 'on_time';
    return 'late';
  }

  private computeDailyCounts(
    employees: { id: number }[],
    records: Map<number, attendance_staff_daily>,
    offDayIds: Set<number>,
    expectedByEmployee: Map<number, { expectedCheckIn: Date | null; graceMinutes: number }>,
  ) {
    let onTime = 0;
    let late = 0;
    let early = 0;
    let absent = 0;
    let noClockIn = 0;
    let noClockOut = 0;
    let dayOff = 0;

    for (const emp of employees) {
      if (offDayIds.has(emp.id)) {
        dayOff++;
        continue;
      }

      const record = records.get(emp.id);
      if (!record) {
        noClockIn++;
        continue;
      }
      if (record.status === StaffAttendanceStatus.ABSENT) {
        absent++;
        continue;
      }
      if (StaffAttendanceService.PAID_LEAVE_STATUSES.has(record.status)) {
        dayOff++;
        continue;
      }
      if (!record.check_in_at) {
        noClockIn++;
      } else {
        const expected = expectedByEmployee.get(emp.id);
        const cls = this.classifyCheckIn(
          record.check_in_at,
          expected?.expectedCheckIn ?? null,
          expected?.graceMinutes ?? 0,
        );
        if (cls === 'on_time') onTime++;
        else if (cls === 'late') late++;
        else early++;
      }
      if (!record.check_out_at) noClockOut++;
    }

    return { onTime, late, early, absent, noClockIn, noClockOut, dayOff };
  }

  private async getOffDayEmployeeIds(
    campusId: number,
    employees: { id: number }[],
    date: Date,
  ): Promise<Set<number>> {
    const offDayIds = new Set<number>();
    await Promise.all(
      employees.map(async (emp) => {
        const resolved = await this.calendarResolver.resolveStaffDay(emp.id, campusId, date);
        if (!resolved.isWorkingDay) offDayIds.add(emp.id);
      }),
    );
    return offDayIds;
  }

  private async getCountsForDate(campusId: number, departmentId: number | undefined, date: Date) {
    const employees = await this.getEmployeesInScope(campusId, departmentId);
    if (employees.length === 0) {
      return { onTime: 0, late: 0, early: 0, absent: 0, noClockIn: 0, noClockOut: 0, dayOff: 0 };
    }

    const records = await this.prisma.attendance_staff_daily.findMany({
      where: { date, employee_id: { in: employees.map((e) => e.id) } },
    });
    const recordMap = new Map(records.map((r) => [r.employee_id, r]));
    const offDayIds = await this.getOffDayEmployeeIds(campusId, employees, date);

    const expectedEntries = await Promise.all(
      employees.map(async (emp) => {
        const resolved = await this.expectedTimes.resolveExpectedTimes(emp.id, campusId, date);
        return [
          emp.id,
          {
            expectedCheckIn: resolved.expectedCheckIn,
            graceMinutes: resolved.graceMinutes,
          },
        ] as const;
      }),
    );
    const expectedByEmployee = new Map(expectedEntries);

    return this.computeDailyCounts(employees, recordMap, offDayIds, expectedByEmployee);
  }

  async getSummary(query: GetStaffAttendanceQueryDto, user: IJwtStaffPayload) {
    const date = this.parseDate(query.date);
    const campusId = query.campus_id ?? user.campusId ?? undefined;
    if (!campusId) throw new BadRequestException('campus_id is required');
    this.assertCampusAccess(user, campusId);

    const previousDate = new Date(date);
    previousDate.setUTCDate(previousDate.getUTCDate() - 1);

    const [today, yesterday] = await Promise.all([
      this.getCountsForDate(campusId, query.department_id, date),
      this.getCountsForDate(campusId, query.department_id, previousDate),
    ]);

    const card = (key: keyof typeof today) => ({ count: today[key], delta: today[key] - yesterday[key] });

    return {
      present_summary: {
        on_time: card('onTime'),
        late: card('late'),
        early: card('early'),
      },
      not_present_summary: {
        absent: card('absent'),
        no_clock_in: card('noClockIn'),
        no_clock_out: card('noClockOut'),
        invalid: { count: 0, delta: 0 },
      },
      away_summary: {
        day_off: card('dayOff'),
        time_off: { count: 0, delta: 0 },
      },
    };
  }

  // max(0, check_out_at - leaving_time) in minutes, or null when not computable.
  private computeOvertimeMinutes(checkOutAt: Date | null | undefined, leavingTime: Date | null | undefined): number | null {
    if (!checkOutAt || !leavingTime) return null;
    const checkOutMinutes = checkOutAt.getUTCHours() * 60 + checkOutAt.getUTCMinutes();
    const leavingMinutes = leavingTime.getUTCHours() * 60 + leavingTime.getUTCMinutes();
    return Math.max(0, checkOutMinutes - leavingMinutes);
  }

  async getDashboard(query: GetStaffAttendanceQueryDto, user: IJwtStaffPayload) {
    const date = this.parseDate(query.date);
    const campusId = query.campus_id ?? user.campusId ?? undefined;
    if (!campusId) throw new BadRequestException('campus_id is required');
    this.assertCampusAccess(user, campusId);

    const employees = await this.getEmployeesInScope(campusId, query.department_id);
    if (employees.length === 0) return [];

    const records = await this.prisma.attendance_staff_daily.findMany({
      where: { date, employee_id: { in: employees.map((e) => e.id) } },
    });
    const recordMap = new Map(records.map((r) => [r.employee_id, r]));

    const expectedEntries = await Promise.all(
      employees.map(async (emp) => {
        const resolved = await this.expectedTimes.resolveExpectedTimes(emp.id, campusId, date);
        return [emp.id, resolved] as const;
      }),
    );
    const expectedByEmployee = new Map(expectedEntries);

    return employees.map((emp) => {
      const record = recordMap.get(emp.id) ?? null;
      const expected = expectedByEmployee.get(emp.id);
      return {
        employee: {
          id: emp.id,
          full_name: emp.full_name,
          employee_code: emp.employee_code,
          job_title: emp.job_title,
          photo_url: emp.photo_url,
          department: emp.departments?.name ?? null,
        },
        check_in_at: record?.check_in_at ?? null,
        check_out_at: record?.check_out_at ?? null,
        overtime_minutes: this.computeOvertimeMinutes(
          record?.check_out_at,
          expected?.expectedCheckOut ?? null,
        ),
        location: emp.campuses?.campus_name ?? null,
        note: record?.notes ?? null,
        status: record?.status ?? null,
      };
    });
  }

  private static readonly PAID_LEAVE_STATUSES = new Set<StaffAttendanceStatus>([
    StaffAttendanceStatus.EXCUSED,
    StaffAttendanceStatus.SICK_LEAVE,
    StaffAttendanceStatus.CASUAL_LEAVE,
    StaffAttendanceStatus.ANNUAL_LEAVE,
  ]);

  // Derives Working time (IN->OUT), Break (OUT->IN gaps), and Overtime
  // (the portion of the final OUT after leaving_time) segments for one day
  // from the persisted scan sequence.
  private buildDaySegments(
    scans: zk_attendance_scans[],
    leavingTime: Date | null,
    record: attendance_staff_daily | null,
  ) {
    const segments: { type: 'WORK' | 'BREAK' | 'OVERTIME' | 'DAY_OFF'; start: string; end: string }[] = [];

    if (record?.source === AttendanceSource.MANUAL && record.check_in_at) {
      const start = record.check_in_at.toISOString();
      const end = record.check_out_at ? record.check_out_at.toISOString() : start;
      segments.push({ type: 'WORK', start, end });
      return segments;
    }

    if (record?.status && StaffAttendanceService.PAID_LEAVE_STATUSES.has(record.status)) {
      segments.push({ type: 'DAY_OFF', start: '00:00', end: '24:00' });
      return segments;
    }

    if (record?.status === StaffAttendanceStatus.UNPAID_LEAVE) {
      return segments;
    }

    if (record && !record.check_in_at && record.status !== StaffAttendanceStatus.ABSENT) {
      segments.push({ type: 'DAY_OFF', start: '00:00', end: '24:00' });
      return segments;
    }

    for (let i = 0; i + 1 < scans.length; i += 2) {
      const inTime = scans[i].scan_time;
      const outTime = scans[i + 1].scan_time;
      const isLastPair = i + 2 >= scans.length;

      if (isLastPair && leavingTime) {
        const leavingMinutes = leavingTime.getUTCHours() * 60 + leavingTime.getUTCMinutes();
        const outMinutes = outTime.getUTCHours() * 60 + outTime.getUTCMinutes();
        const inMinutes = inTime.getUTCHours() * 60 + inTime.getUTCMinutes();

        if (outMinutes > leavingMinutes && leavingMinutes > inMinutes) {
          const overtimeStart = new Date(outTime);
          overtimeStart.setUTCHours(leavingTime.getUTCHours(), leavingTime.getUTCMinutes(), 0, 0);
          segments.push({ type: 'WORK', start: inTime.toISOString(), end: overtimeStart.toISOString() });
          segments.push({ type: 'OVERTIME', start: overtimeStart.toISOString(), end: outTime.toISOString() });
          continue;
        }

        if (outMinutes > leavingMinutes) {
          segments.push({ type: 'OVERTIME', start: inTime.toISOString(), end: outTime.toISOString() });
          continue;
        }
      }

      segments.push({ type: 'WORK', start: inTime.toISOString(), end: outTime.toISOString() });

      if (i + 2 < scans.length) {
        segments.push({ type: 'BREAK', start: outTime.toISOString(), end: scans[i + 2].scan_time.toISOString() });
      }
    }

    if (scans.length > 0 && scans.length % 2 !== 0) {
      const lastInTime = scans[scans.length - 1].scan_time;
      const end = new Date(lastInTime.getTime() + 10 * 60 * 1000);
      segments.push({ type: 'WORK', start: lastInTime.toISOString(), end: end.toISOString(), isMissingOut: true } as any);
    }

    return segments;
  }

  async getMyAttendance(userId: string, query: GetMyStaffAttendanceQueryDto) {
    const employee = await this.employeeResolver.requireByUserId(userId);
    const maxPeriod = currentPayrollPeriodLabel();
    if (query.period > maxPeriod) {
      throw new BadRequestException('Cannot view attendance for a future payroll period');
    }

    const { year, month } = parsePayrollPeriod(query.period);
    const { periodStart, periodEnd } = computePayrollWindow(year, month);
    const campusId = employee.campus_id ?? 0;

    const [scans, records, objections, payrollLine, scheduleCtx, calendarRows, mandatorySaturdayDates] = await Promise.all([
      this.prisma.zk_attendance_scans.findMany({
        where: {
          employee_id: employee.id,
          person_type: 'STAFF',
          is_duplicate: false,
          attendance_date: { gte: periodStart, lte: periodEnd },
        },
        orderBy: { scan_time: 'asc' },
      }),
      this.prisma.attendance_staff_daily.findMany({
        where: { employee_id: employee.id, date: { gte: periodStart, lte: periodEnd } },
      }),
      this.prisma.attendance_objections.findMany({
        where: { employee_id: employee.id, attendance_date: { gte: periodStart, lte: periodEnd } },
      }),
      this.prisma.payroll_run_lines.findFirst({
        where: {
          employee_id: employee.id,
          payroll_runs: { period_start: periodStart, period_end: periodEnd },
        },
        include: { payroll_runs: { select: { status: true } } },
      }),
      this.prisma.employee_profiles.findUnique({
        where: { id: employee.id },
        select: {
          department_id: true,
          staff_category: true,
          days_per_week: true,
          employee_work_schedules: { select: { day_of_week: true, is_working: true } },
        },
      }),
      campusId
        ? this.calendarResolver.loadStaffCalendarRows(campusId, periodStart, periodEnd)
        : Promise.resolve([]),
      campusId
        ? this.calendarResolver.loadMandatorySaturdayDates(employee.id, periodStart, periodEnd)
        : Promise.resolve(new Set<string>()),
    ]);

    const scansByDate = new Map<string, typeof scans>();
    for (const scan of scans) {
      const key = scan.attendance_date.toISOString().slice(0, 10);
      const bucket = scansByDate.get(key);
      if (bucket) bucket.push(scan);
      else scansByDate.set(key, [scan]);
    }
    const recordMap = new Map(records.map((r) => [r.date.toISOString().slice(0, 10), r]));
    const objectionsByDate = new Map<string, typeof objections>();
    for (const obj of objections) {
      const key = obj.attendance_date.toISOString().slice(0, 10);
      const bucket = objectionsByDate.get(key);
      if (bucket) bucket.push(obj);
      else objectionsByDate.set(key, [obj]);
    }

    const days: {
      date: string;
      status: StaffAttendanceStatus | null;
      check_in_at: string | null;
      check_out_at: string | null;
      scans: { id: number; scan_time: string; direction: string | null }[];
      is_working_day: boolean;
      day_type: string | null;
      objections: { id: number; scan_id: number | null; claimed_time: string; status: string }[];
    }[] = [];

    for (
      let d = new Date(periodStart);
      d <= periodEnd;
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
    ) {
      const key = d.toISOString().slice(0, 10);
      const record = recordMap.get(key) ?? null;
      const resolved = campusId
        ? this.calendarResolver.resolveStaffDayFromRows(
            calendarRows,
            new Date(d),
            employee.id,
            scheduleCtx?.department_id ?? null,
            scheduleCtx?.staff_category ?? null,
            scheduleCtx?.days_per_week ?? null,
            scheduleCtx?.employee_work_schedules ?? [],
            mandatorySaturdayDates,
          )
        : { isWorkingDay: true, dayType: null, description: null, source: 'DEFAULT' as const };

      const dayScans = scansByDate.get(key) ?? [];
      days.push({
        date: key,
        status: record?.status ?? (resolved.isWorkingDay ? null : StaffAttendanceStatus.EXCUSED),
        check_in_at: record?.check_in_at?.toISOString() ?? dayScans[0]?.scan_time.toISOString() ?? null,
        check_out_at:
          record?.check_out_at?.toISOString() ??
          (dayScans.length > 0 && dayScans.length % 2 === 0
            ? dayScans[dayScans.length - 1].scan_time.toISOString()
            : null),
        scans: dayScans.map((s) => ({
          id: s.id,
          scan_time: s.scan_time.toISOString(),
          direction: s.direction,
        })),
        is_working_day: resolved.isWorkingDay,
        day_type: resolved.dayType,
        objections: (objectionsByDate.get(key) ?? []).map((o) => ({
          id: o.id,
          scan_id: o.scan_id,
          claimed_time: o.claimed_time.toISOString(),
          status: o.status,
        })),
      });
    }

    let payroll_snapshot: {
      status: string;
      disbursed_at: string | null;
      disbursement_notes: string | null;
      daily_rate: number;
      per_minute_rate: number;
      daily_breakdown: DayBreakdownEntry[];
    } | null = null;

    if (payrollLine) {
      const breakdown = payrollLine.daily_breakdown as unknown as DayBreakdownEntry[];
      payroll_snapshot = {
        status: payrollLine.payroll_runs.status,
        disbursed_at: payrollLine.disbursed_at?.toISOString() ?? null,
        disbursement_notes: payrollLine.disbursement_notes,
        daily_rate: Number(payrollLine.daily_rate),
        per_minute_rate: Number(payrollLine.per_minute_rate),
        daily_breakdown: breakdown,
      };
    }

    return {
      period: query.period,
      period_start: periodStart.toISOString().slice(0, 10),
      period_end: periodEnd.toISOString().slice(0, 10),
      days,
      payroll_snapshot,
    };
  }

  async getTimeline(employeeId: number, query: GetStaffTimelineQueryDto, user: IJwtStaffPayload) {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { id: true, full_name: true, campus_id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    if (employee.campus_id) this.assertCampusAccess(user, employee.campus_id);

    const dateFrom = this.parseDate(query.date_from);
    const dateTo = this.parseDate(query.date_to);
    if (dateFrom > dateTo) throw new BadRequestException('date_from must be before date_to');

    const [scans, records] = await Promise.all([
      this.prisma.zk_attendance_scans.findMany({
        where: {
          employee_id: employeeId,
          person_type: 'STAFF',
          is_duplicate: false,
          attendance_date: { gte: dateFrom, lte: dateTo },
        },
        orderBy: { scan_time: 'asc' },
      }),
      this.prisma.attendance_staff_daily.findMany({
        where: { employee_id: employeeId, date: { gte: dateFrom, lte: dateTo } },
      }),
    ]);

    const scansByDate = new Map<string, zk_attendance_scans[]>();
    for (const scan of scans) {
      const key = scan.attendance_date.toISOString();
      const bucket = scansByDate.get(key);
      if (bucket) bucket.push(scan);
      else scansByDate.set(key, [scan]);
    }
    const recordMap = new Map(records.map((r) => [r.date.toISOString(), r]));

    const days: {
      date: string;
      status: StaffAttendanceStatus | null;
      is_working_day: boolean;
      day_type: string | null;
      day_description: string | null;
      segments: ReturnType<StaffAttendanceService['buildDaySegments']>;
    }[] = [];
    for (let d = new Date(dateFrom); d <= dateTo; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))) {
      const key = d.toISOString();
      const record = recordMap.get(key) ?? null;
      const campusId = employee.campus_id ?? 0;
      const resolved = campusId
        ? await this.calendarResolver.resolveStaffDay(employeeId, campusId, new Date(d))
        : { isWorkingDay: true, dayType: null, description: null, source: 'DEFAULT' as const };

      const expected = campusId
        ? await this.expectedTimes.resolveExpectedTimes(employeeId, campusId, new Date(d))
        : { expectedCheckOut: null as Date | null };

      let segments = this.buildDaySegments(
        scansByDate.get(key) ?? [],
        expected.expectedCheckOut ?? null,
        record,
      );
      if (!resolved.isWorkingDay && segments.length === 0) {
        segments = [{ type: 'DAY_OFF', start: '00:00', end: '24:00' }];
      }

      days.push({
        date: key.slice(0, 10),
        status: record?.status ?? (resolved.isWorkingDay ? null : StaffAttendanceStatus.EXCUSED),
        is_working_day: resolved.isWorkingDay,
        day_type: resolved.dayType,
        day_description: resolved.description,
        segments,
      });
    }

    return {
      employee: { id: employee.id, full_name: employee.full_name },
      days,
    };
  }

  async bulkMark(dto: BulkMarkStaffAttendanceDto, user: IJwtStaffPayload) {
    this.assertCampusAccess(user, dto.campus_id);

    const date = this.parseDate(dto.date);

    // Validate all employee IDs belong to this campus.
    // Accept either employee_profiles.campus_id (dummy/direct employees) or
    // users.campus_id (normal accounts), since payroll generation uses the latter.
    const employeeIds = dto.records.map((r) => r.employee_id);
    const employees = await this.prisma.employee_profiles.findMany({
      where: {
        id: { in: employeeIds },
        OR: [
          { campus_id: dto.campus_id },
          { users: { campus_id: dto.campus_id } },
        ],
      },
      select: { id: true },
    });

    const validIds = new Set(employees.map((e) => e.id));
    const invalid = employeeIds.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Employee IDs not found on this campus: ${invalid.join(', ')}`,
      );
    }

    for (const mark of dto.records) {
      const resolved = await this.calendarResolver.resolveStaffDay(mark.employee_id, dto.campus_id, date);
      if (!resolved.isWorkingDay) {
        throw new BadRequestException(
          `Cannot mark attendance on a day off: ${resolved.description ?? resolved.dayType ?? 'Holiday'}`,
        );
      }
    }

    // Upsert all records in a transaction
    const upserts = dto.records.map((mark) => {
      let checkInAt: Date | null | undefined = undefined;
      let checkOutAt: Date | null | undefined = undefined;
      const clearsPunches =
        mark.status === StaffAttendanceStatus.ABSENT ||
        mark.status === StaffAttendanceStatus.UNPAID_LEAVE ||
        StaffAttendanceService.PAID_LEAVE_STATUSES.has(mark.status);

      if (clearsPunches) {
        checkInAt = null;
        checkOutAt = null;
      } else {
        if (mark.check_in_time) {
          const [h, m] = mark.check_in_time.split(':').map(Number);
          checkInAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, m, 0));
        }
        if (mark.check_out_time) {
          const [h, m] = mark.check_out_time.split(':').map(Number);
          checkOutAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, m, 0));
        }
      }

      return this.prisma.attendance_staff_daily.upsert({
        where: { employee_id_date: { employee_id: mark.employee_id, date } },
        create: {
          employee_id: mark.employee_id,
          campus_id: dto.campus_id,
          date,
          status: mark.status,
          notes: mark.notes ?? null,
          marked_by: user.sub,
          source: AttendanceSource.MANUAL,
          ...(checkInAt !== undefined ? { check_in_at: checkInAt } : {}),
          ...(checkOutAt !== undefined ? { check_out_at: checkOutAt } : {}),
        },
        update: {
          status: mark.status,
          notes: mark.notes ?? null,
          marked_by: user.sub,
          source: AttendanceSource.MANUAL,
          ...(checkInAt !== undefined ? { check_in_at: checkInAt } : {}),
          ...(checkOutAt !== undefined ? { check_out_at: checkOutAt } : {}),
        },
      });
    });

    await this.prisma.$transaction(upserts);

    this.auditLogs.log({
      entity_type: 'STAFF_ATTENDANCE',
      entity_id: String(dto.campus_id),
      action: 'CREATED',
      section: 'attendance',
      note: `Bulk marked ${dto.records.length} staff for ${dto.date}`,
      changed_by: user.username || user.sub,
    });

    // Avoid reloading the full campus register here — getRegister() runs holiday
    // sync for every enrolled student plus per-employee calendar resolution and
    // can take minutes, causing PUT timeouts from payroll/staff UIs that only
    // need confirmation that the save succeeded.
    return { saved_count: dto.records.length };
  }
}
