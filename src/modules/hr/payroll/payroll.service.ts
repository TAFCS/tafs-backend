import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceSource, Prisma, PayrollRunStatus, StaffAttendanceStatus, StaffCategory, attendance_staff_daily, zk_attendance_scans } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CalendarDayResolverService } from '../calendar/calendar-day-resolver.service';
import { GeneratePayrollRunDto, ListPayrollRunsQueryDto } from './dto/payroll.dto';
import { DisbursePayrollLineDto } from './dto/payroll-self.dto';
import { computePayrollWindow } from './payroll-period.util';

type StaffCalendarRows = Awaited<ReturnType<CalendarDayResolverService['loadStaffCalendarRows']>>;
type AttendanceStaffDailyRow = attendance_staff_daily;

interface EmployeeLineInput {
  id: number;
  monthly_pay: Prisma.Decimal | null;
  reporting_time: Date | null;
  leaving_time: Date | null;
  late_relaxation_minutes: number | null;
  department_id: number | null;
  staff_category: StaffCategory | null;
  days_per_week: number | null;
  employee_work_schedules: { day_of_week: number; is_working: boolean }[];
}

type DayClassification = 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' | 'EXCUSED' | 'SICK_LEAVE' | 'CASUAL_LEAVE' | 'ANNUAL_LEAVE' | 'UNPAID_LEAVE' | 'UNRESOLVED' | 'DAY_OFF';

export interface DayBreakdownEntry {
  date: string;
  is_working_day: boolean;
  day_type: string | null;
  day_description: string | null;
  classification: DayClassification;
  check_in_at: string | null;
  check_out_at: string | null;
  break_minutes: number;
  late_minutes: number;
  source: AttendanceSource | null;
  segments?: { type: string; start: string; end: string; isMissingOut?: boolean }[];
}

interface ComputedLine {
  scheduled_working_days: number;
  present_days: number;
  late_days: number;
  half_days: number;
  absent_days: number;
  excused_days: number;
  unpaid_leave_days: number;
  unresolved_days: number;
  total_break_minutes: number;
  total_late_minutes: number;
  monthly_pay: Prisma.Decimal;
  daily_rate: Prisma.Decimal;
  per_minute_rate: Prisma.Decimal;
  absence_deduction: Prisma.Decimal;
  half_day_deduction: Prisma.Decimal;
  late_deduction: Prisma.Decimal;
  break_deduction: Prisma.Decimal;
  total_deductions: Prisma.Decimal;
  net_pay: Prisma.Decimal;
  daily_breakdown: DayBreakdownEntry[];
}

const runInclude = {
  campuses: { select: { id: true, campus_name: true } },
  payroll_run_lines: {
    include: {
      employee_profiles: {
        select: { id: true, full_name: true, employee_code: true, job_title: true, photo_url: true },
      },
    },
  },
};

/**
 * Payroll calculation is a snapshot, not a live view: deductions are computed
 * and persisted at generation time so a finalized run stays stable even if
 * attendance records are corrected afterwards. Re-generating a DRAFT run for
 * the same period recomputes everything from current attendance data.
 *
 * Absence deduction = prorated daily rate (monthly_pay / scheduled working
 * days in the period). Break deduction = every OUT->IN gap between scan
 * pairs (mirrors the pairing logic in zk-attendance-processor.service.ts /
 * staff-attendance.service.ts#buildDaySegments) at a per-minute rate derived
 * from the employee's own reporting_time/leaving_time window. Both formulas
 * were explicit product decisions, not inferred — see the conversation that
 * produced this module for the alternatives that were rejected.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarResolver: CalendarDayResolverService,
  ) {}

  // Fixed school payroll cycle — see payroll-period.util.ts
  private computePayrollWindow(year: number, month: number) {
    return computePayrollWindow(year, month);
  }

  private assertCampusAccess(user: IJwtStaffPayload, campusId: number) {
    if (user.campusId && user.campusId !== campusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }
  }

  private scheduledMinutesPerDay(reportingTime: Date | null, leavingTime: Date | null): number {
    if (!reportingTime || !leavingTime) return 0;
    const start = reportingTime.getUTCHours() * 60 + reportingTime.getUTCMinutes();
    const end = leavingTime.getUTCHours() * 60 + leavingTime.getUTCMinutes();
    return Math.max(0, end - start);
  }

  // Mirrors the IN/OUT pairing convention in ZkAttendanceProcessorService:
  // even index = IN, odd index = OUT. A break is the gap between an OUT and
  // the next IN — i.e. between odd index i and even index i+1.
  private sumBreakMinutes(scansForOneDay: zk_attendance_scans[]): number {
    let minutes = 0;
    for (let i = 1; i + 1 < scansForOneDay.length; i += 2) {
      const outTime = scansForOneDay[i].scan_time;
      const nextInTime = scansForOneDay[i + 1].scan_time;
      minutes += Math.max(0, (nextInTime.getTime() - outTime.getTime()) / 60000);
    }
    return minutes;
  }

  private buildDaySegments(
    scans: zk_attendance_scans[],
    leavingTime: Date | null,
    record: AttendanceStaffDailyRow | null,
  ) {
    const segments: { type: 'WORK' | 'BREAK' | 'OVERTIME' | 'DAY_OFF'; start: string; end: string; isMissingOut?: boolean }[] = [];

    if (record?.source === AttendanceSource.MANUAL && record.check_in_at) {
      const start = record.check_in_at.toISOString();
      const end = record.check_out_at ? record.check_out_at.toISOString() : start;
      segments.push({ type: 'WORK', start, end });
      return segments;
    }

    if (
      record?.status === StaffAttendanceStatus.EXCUSED ||
      record?.status === StaffAttendanceStatus.SICK_LEAVE ||
      record?.status === StaffAttendanceStatus.CASUAL_LEAVE ||
      record?.status === StaffAttendanceStatus.ANNUAL_LEAVE
    ) {
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
      segments.push({ type: 'WORK', start: lastInTime.toISOString(), end: end.toISOString(), isMissingOut: true });
    }

    return segments;
  }

  private groupScansByDate(scans: zk_attendance_scans[]): Map<string, zk_attendance_scans[]> {
    const byDate = new Map<string, zk_attendance_scans[]>();
    for (const scan of scans) {
      const key = scan.attendance_date.toISOString().slice(0, 10);
      const bucket = byDate.get(key);
      if (bucket) bucket.push(scan);
      else byDate.set(key, [scan]);
    }
    return byDate;
  }

  private computeEmployeeLine(
    employee: EmployeeLineInput,
    periodStart: Date,
    periodEnd: Date,
    calendarRows: StaffCalendarRows,
    attendanceRecords: AttendanceStaffDailyRow[],
    scans: zk_attendance_scans[],
    mandatorySaturdayDates?: Set<string>,
  ): ComputedLine {
    const recordByDate = new Map(attendanceRecords.map((r) => [r.date.toISOString().slice(0, 10), r]));
    const scansByDate = this.groupScansByDate(scans);

    // Walk every calendar day in the period once and classify it — this array
    // is the single source of truth; every aggregate below is derived from it
    // so the per-day detail shown in the UI can never drift from the totals.
    //
    // Every working day always gets exactly one clock-in/clock-out pair. A
    // manual override (HR explicitly marking EXCUSED/ABSENT/etc.) always
    // wins. Otherwise: zero scans that day -> no clock-in -> absent. An odd
    // scan count -> a clock-in with no matching clock-out -> unresolved, not
    // guessed at. Only a clean, paired day falls back to the biometric status.
    const dailyBreakdown: DayBreakdownEntry[] = [];
    for (
      let d = new Date(periodStart);
      d <= periodEnd;
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
    ) {
      const key = d.toISOString().slice(0, 10);
      const resolved = this.calendarResolver.resolveStaffDayFromRows(
        calendarRows,
        new Date(d),
        employee.id,
        employee.department_id,
        employee.staff_category,
        employee.days_per_week,
        employee.employee_work_schedules,
        mandatorySaturdayDates,
      );
      const record = recordByDate.get(key);
      const dayScans = scansByDate.get(key) ?? [];
      const breakMinutes = Math.round(this.sumBreakMinutes(dayScans));

      let classification: DayClassification;
      if (!resolved.isWorkingDay) {
        classification = 'DAY_OFF';
      } else if (
        record?.source === AttendanceSource.MANUAL ||
        record?.source === AttendanceSource.LEAVE
      ) {
        classification = record.status as DayClassification;
      } else if (dayScans.length === 0) {
        classification = 'ABSENT';
      } else if (dayScans.length % 2 !== 0) {
        classification = 'UNRESOLVED';
      } else if (record?.status === StaffAttendanceStatus.LATE) {
        classification = 'LATE';
      } else {
        classification = 'PRESENT';
      }

      let segments = this.buildDaySegments(dayScans, employee.leaving_time, record ?? null);
      if (!resolved.isWorkingDay && segments.length === 0) {
        segments = [{ type: 'DAY_OFF', start: '00:00', end: '24:00' }];
      }

      const manualClearsPunches =
        record?.source === AttendanceSource.MANUAL ||
        record?.source === AttendanceSource.LEAVE
          ? record.status === StaffAttendanceStatus.ABSENT ||
            record.status === StaffAttendanceStatus.EXCUSED ||
            record.status === StaffAttendanceStatus.SICK_LEAVE ||
            record.status === StaffAttendanceStatus.CASUAL_LEAVE ||
            record.status === StaffAttendanceStatus.ANNUAL_LEAVE ||
            record.status === StaffAttendanceStatus.UNPAID_LEAVE
          : false;

      const checkInAt =
        manualClearsPunches
          ? null
          : record?.source === AttendanceSource.MANUAL
            ? record.check_in_at
            : dayScans[0]?.scan_time ?? record?.check_in_at ?? null;
      const checkOutAt =
        manualClearsPunches
          ? null
          : record?.source === AttendanceSource.MANUAL
            ? record.check_out_at
            : dayScans.length > 0 && dayScans.length % 2 === 0
              ? dayScans[dayScans.length - 1].scan_time
              : record?.check_out_at ?? null;

      if (manualClearsPunches) {
        segments = [];
      }

      // Grace window is a gate, not a subsidy: if the employee arrives within
      // late_relaxation_minutes they pay nothing; if they exceed it they pay
      // for ALL late minutes (e.g. 6 min late with 5 min grace → 6 min deducted).
      let lateMinutes = 0;
      if (classification === 'LATE' && checkInAt && employee.reporting_time) {
        const reportingMinutes = employee.reporting_time.getUTCHours() * 60 + employee.reporting_time.getUTCMinutes();
        const checkInMinutes = checkInAt.getUTCHours() * 60 + checkInAt.getUTCMinutes();
        const rawLate = checkInMinutes - reportingMinutes;
        const relaxation = employee.late_relaxation_minutes ?? 0;
        lateMinutes = rawLate > relaxation ? rawLate : 0;
      }

      dailyBreakdown.push({
        date: key,
        is_working_day: resolved.isWorkingDay,
        day_type: resolved.dayType,
        day_description: resolved.description,
        classification,
        check_in_at: checkInAt?.toISOString() ?? null,
        check_out_at: checkOutAt?.toISOString() ?? null,
        break_minutes: manualClearsPunches ? 0 : breakMinutes,
        late_minutes: lateMinutes,
        source: record?.source ?? (dayScans.length ? AttendanceSource.BIOMETRIC : null),
        segments,
      });
    }

    const scheduledWorkingDays = dailyBreakdown.filter((d) => d.is_working_day).length;
    const presentDays = dailyBreakdown.filter((d) => d.classification === 'PRESENT' || d.classification === 'LATE').length;
    const lateDays = dailyBreakdown.filter((d) => d.classification === 'LATE').length;
    const halfDays = dailyBreakdown.filter((d) => d.classification === 'HALF_DAY').length;
    const absentDays = dailyBreakdown.filter((d) => d.classification === 'ABSENT').length;
    const excusedDays = dailyBreakdown.filter((d) =>
      d.classification === 'EXCUSED' ||
      d.classification === 'SICK_LEAVE' ||
      d.classification === 'CASUAL_LEAVE' ||
      d.classification === 'ANNUAL_LEAVE',
    ).length;
    const unpaidLeaveDays = dailyBreakdown.filter((d) => d.classification === 'UNPAID_LEAVE').length;
    const unresolvedDays = dailyBreakdown.filter((d) => d.classification === 'UNRESOLVED').length;
    const totalBreakMinutes = dailyBreakdown.reduce((sum, d) => sum + d.break_minutes, 0);
    const totalLateMinutes = dailyBreakdown.reduce((sum, d) => sum + d.late_minutes, 0);

    const monthlyPay = new Prisma.Decimal(employee.monthly_pay ?? 0);
    const dailyRate = scheduledWorkingDays > 0 ? monthlyPay.dividedBy(scheduledWorkingDays) : new Prisma.Decimal(0);

    const scheduledMinutes = this.scheduledMinutesPerDay(employee.reporting_time, employee.leaving_time);
    const perMinuteRate = scheduledMinutes > 0 ? dailyRate.dividedBy(scheduledMinutes) : new Prisma.Decimal(0);

    const absenceDeduction = dailyRate.times(absentDays + unpaidLeaveDays);
    const halfDayDeduction = dailyRate.dividedBy(2).times(halfDays);
    const lateDeduction = perMinuteRate.times(totalLateMinutes);
    const breakDeduction = perMinuteRate.times(totalBreakMinutes);
    const totalDeductions = absenceDeduction.plus(halfDayDeduction).plus(lateDeduction).plus(breakDeduction);
    const netPay = monthlyPay.minus(totalDeductions);

    return {
      scheduled_working_days: scheduledWorkingDays,
      present_days: presentDays,
      late_days: lateDays,
      half_days: halfDays,
      absent_days: absentDays,
      excused_days: excusedDays,
      unpaid_leave_days: unpaidLeaveDays,
      unresolved_days: unresolvedDays,
      total_break_minutes: totalBreakMinutes,
      total_late_minutes: totalLateMinutes,
      monthly_pay: monthlyPay.toDecimalPlaces(2),
      daily_rate: dailyRate.toDecimalPlaces(2),
      per_minute_rate: perMinuteRate.toDecimalPlaces(4),
      absence_deduction: absenceDeduction.toDecimalPlaces(2),
      half_day_deduction: halfDayDeduction.toDecimalPlaces(2),
      late_deduction: lateDeduction.toDecimalPlaces(2),
      break_deduction: breakDeduction.toDecimalPlaces(2),
      total_deductions: totalDeductions.toDecimalPlaces(2),
      net_pay: netPay.toDecimalPlaces(2),
      daily_breakdown: dailyBreakdown,
    };
  }

  async generateRun(dto: GeneratePayrollRunDto, user: IJwtStaffPayload) {
    this.assertCampusAccess(user, dto.campus_id);

    const { periodStart, periodEnd } = this.computePayrollWindow(dto.year, dto.month);

    const employees = await this.prisma.employee_profiles.findMany({
      where: { campus_id: dto.campus_id, monthly_pay: { not: null } },
      select: {
        id: true,
        monthly_pay: true,
        reporting_time: true,
        leaving_time: true,
        late_relaxation_minutes: true,
        department_id: true,
        staff_category: true,
        days_per_week: true,
        employee_work_schedules: { select: { day_of_week: true, is_working: true } },
      },
    });
    if (employees.length === 0) {
      throw new BadRequestException('No employees on this campus have a monthly_pay set yet — nothing to calculate.');
    }

    // Everything below is loaded once for the whole run (not once per
    // employee, let alone once per employee per day) and matched in memory —
    // a single employee-by-employee query loop here took minutes over the
    // network round-trip cost to the remote DB.
    const employeeIds = employees.map((e) => e.id);
    const [calendarRows, mandatoryByEmployee, allAttendanceRecords, allScans] = await Promise.all([
      this.calendarResolver.loadStaffCalendarRows(dto.campus_id, periodStart, periodEnd),
      this.calendarResolver.loadMandatorySaturdayDatesForEmployees(employeeIds, periodStart, periodEnd),
      this.prisma.attendance_staff_daily.findMany({
        where: { employee_id: { in: employeeIds }, date: { gte: periodStart, lte: periodEnd } },
      }),
      this.prisma.zk_attendance_scans.findMany({
        where: {
          employee_id: { in: employeeIds },
          person_type: 'STAFF',
          is_duplicate: false,
          attendance_date: { gte: periodStart, lte: periodEnd },
        },
        orderBy: { scan_time: 'asc' },
      }),
    ]);

    const attendanceByEmployee = new Map<number, AttendanceStaffDailyRow[]>();
    for (const r of allAttendanceRecords) {
      const bucket = attendanceByEmployee.get(r.employee_id);
      if (bucket) bucket.push(r);
      else attendanceByEmployee.set(r.employee_id, [r]);
    }
    const scansByEmployee = new Map<number, zk_attendance_scans[]>();
    for (const s of allScans) {
      if (s.employee_id == null) continue;
      const bucket = scansByEmployee.get(s.employee_id);
      if (bucket) bucket.push(s);
      else scansByEmployee.set(s.employee_id, [s]);
    }

    const existing = await this.prisma.payroll_runs.findUnique({
      where: { campus_id_period_start_period_end: { campus_id: dto.campus_id, period_start: periodStart, period_end: periodEnd } },
    });
    if (existing?.status === PayrollRunStatus.FINALIZED) {
      throw new BadRequestException(
        `Payroll for ${dto.year}-${String(dto.month).padStart(2, '0')} on this campus is already finalized. ` +
          `Finalized runs are immutable — this isn't a correction workflow yet.`,
      );
    }

    // Re-generating a DRAFT for the same period replaces it in place (recomputed
    // from current attendance data) rather than piling up duplicate drafts —
    // expected while real attendance data is still being backfilled.
    const run = existing
      ? await this.prisma.payroll_runs.update({
          where: { id: existing.id },
          data: { notes: dto.notes, generated_by: user.sub, generated_at: new Date() },
        })
      : await this.prisma.payroll_runs.create({
          data: {
            campus_id: dto.campus_id,
            period_start: periodStart,
            period_end: periodEnd,
            notes: dto.notes,
            generated_by: user.sub,
          },
        });

    if (existing) {
      await this.prisma.payroll_run_lines.deleteMany({ where: { payroll_run_id: run.id } });
    }

    const lines = employees.map((employee) => ({
      payroll_run_id: run.id,
      employee_id: employee.id,
      ...this.computeEmployeeLine(
        employee,
        periodStart,
        periodEnd,
        calendarRows,
        attendanceByEmployee.get(employee.id) ?? [],
        scansByEmployee.get(employee.id) ?? [],
        mandatoryByEmployee.get(employee.id) ?? new Set<string>(),
      ),
    }));
    await this.prisma.payroll_run_lines.createMany({ data: lines as unknown as Prisma.payroll_run_linesCreateManyInput[] });

    return this.getRun(run.id, user);
  }

  async listRuns(query: ListPayrollRunsQueryDto, user: IJwtStaffPayload) {
    const campusId = query.campus_id ?? user.campusId ?? undefined;
    if (campusId) this.assertCampusAccess(user, campusId);

    const runs = await this.prisma.payroll_runs.findMany({
      where: campusId ? { campus_id: campusId } : undefined,
      include: {
        campuses: { select: { id: true, campus_name: true } },
        _count: { select: { payroll_run_lines: true } },
      },
      orderBy: { period_start: 'desc' },
    });
    if (runs.length === 0) return [];

    const sums = await this.prisma.payroll_run_lines.groupBy({
      by: ['payroll_run_id'],
      where: { payroll_run_id: { in: runs.map((r) => r.id) } },
      _sum: { net_pay: true, total_deductions: true, unresolved_days: true },
    });
    const sumByRunId = new Map(sums.map((s) => [s.payroll_run_id, s._sum]));

    return runs.map((run) => ({
      ...run,
      totals: sumByRunId.get(run.id) ?? { net_pay: null, total_deductions: null, unresolved_days: null },
    }));
  }

  async getRun(id: number, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id }, include: runInclude });
    if (!run) throw new NotFoundException(`Payroll run ${id} not found`);
    this.assertCampusAccess(user, run.campus_id);
    return run;
  }

  async finalizeRun(id: number, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id }, include: { payroll_run_lines: true } });
    if (!run) throw new NotFoundException(`Payroll run ${id} not found`);
    this.assertCampusAccess(user, run.campus_id);
    if (run.status === PayrollRunStatus.FINALIZED) {
      throw new BadRequestException('This payroll run is already finalized.');
    }

    const unresolvedTotal = run.payroll_run_lines.reduce((sum, l) => sum + l.unresolved_days, 0);
    if (unresolvedTotal > 0) {
      throw new BadRequestException(
        `Cannot finalize: ${unresolvedTotal} unresolved attendance day(s) across employees on this run ` +
          `(working days with no attendance record at all). Resolve them in the staff attendance register first, ` +
          `then regenerate this run.`,
      );
    }

    await this.prisma.payroll_runs.update({
      where: { id },
      data: { status: PayrollRunStatus.FINALIZED, finalized_at: new Date() },
    });
    return this.getRun(id, user);
  }

  async deleteRun(id: number, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`Payroll run ${id} not found`);
    this.assertCampusAccess(user, run.campus_id);
    if (run.status === PayrollRunStatus.FINALIZED) {
      throw new BadRequestException('Finalized payroll runs cannot be deleted.');
    }
    await this.prisma.payroll_runs.delete({ where: { id } });
    return { id };
  }

  async listMyPayrollLines(userId: string) {
    const profile = await this.prisma.employee_profiles.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!profile) {
      throw new ForbiddenException('No employee profile is linked to this account');
    }

    const lines = await this.prisma.payroll_run_lines.findMany({
      where: { employee_id: profile.id },
      include: {
        payroll_runs: {
          select: {
            id: true,
            period_start: true,
            period_end: true,
            status: true,
          },
        },
      },
      orderBy: { payroll_runs: { period_start: 'desc' } },
    });

    return lines.map((line) => ({
      payroll_run_id: line.payroll_run_id,
      period_start: line.payroll_runs.period_start.toISOString().slice(0, 10),
      period_end: line.payroll_runs.period_end.toISOString().slice(0, 10),
      run_status: line.payroll_runs.status,
      disbursed_at: line.disbursed_at?.toISOString() ?? null,
      disbursement_notes: line.disbursement_notes,
      monthly_pay: Number(line.monthly_pay),
      total_deductions: Number(line.total_deductions),
      net_pay: Number(line.net_pay),
    }));
  }

  async getMyPayrollDetail(userId: string, payrollRunId: number) {
    const profile = await this.prisma.employee_profiles.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!profile) {
      throw new ForbiddenException('No employee profile is linked to this account');
    }

    const line = await this.prisma.payroll_run_lines.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: payrollRunId, employee_id: profile.id } },
      include: {
        payroll_runs: {
          select: {
            id: true,
            period_start: true,
            period_end: true,
            status: true,
            campuses: { select: { id: true, campus_name: true } },
          },
        },
      },
    });
    if (!line) throw new NotFoundException('Payroll line not found for this period');

    return {
      ...line,
      monthly_pay: Number(line.monthly_pay),
      daily_rate: Number(line.daily_rate),
      per_minute_rate: Number(line.per_minute_rate),
      absence_deduction: Number(line.absence_deduction),
      half_day_deduction: Number(line.half_day_deduction),
      late_deduction: Number(line.late_deduction),
      break_deduction: Number(line.break_deduction),
      total_deductions: Number(line.total_deductions),
      net_pay: Number(line.net_pay),
      disbursed_at: line.disbursed_at?.toISOString() ?? null,
      run: line.payroll_runs,
    };
  }

  async disburseLine(runId: number, employeeId: number, dto: DisbursePayrollLineDto, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);
    if (run.status !== PayrollRunStatus.FINALIZED) {
      throw new BadRequestException('Disbursement is only allowed on finalized payroll runs');
    }

    const disbursedAt = dto.disbursed_at ? new Date(dto.disbursed_at) : new Date();
    if (Number.isNaN(disbursedAt.getTime())) {
      throw new BadRequestException('Invalid disbursed_at');
    }

    const line = await this.prisma.payroll_run_lines.update({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
      data: {
        disbursed_at: disbursedAt,
        disbursed_by: user.sub,
        disbursement_notes: dto.notes ?? null,
      },
    });
    return line;
  }

  async disburseAll(runId: number, dto: DisbursePayrollLineDto, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);
    if (run.status !== PayrollRunStatus.FINALIZED) {
      throw new BadRequestException('Disbursement is only allowed on finalized payroll runs');
    }

    const disbursedAt = dto.disbursed_at ? new Date(dto.disbursed_at) : new Date();
    if (Number.isNaN(disbursedAt.getTime())) {
      throw new BadRequestException('Invalid disbursed_at');
    }

    await this.prisma.payroll_run_lines.updateMany({
      where: { payroll_run_id: runId, disbursed_at: null },
      data: {
        disbursed_at: disbursedAt,
        disbursed_by: user.sub,
        disbursement_notes: dto.notes ?? null,
      },
    });
    return this.getRun(runId, user);
  }
}
