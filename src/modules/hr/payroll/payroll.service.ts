import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { AttendanceSource, Prisma, PayrollRunStatus, OvertimeRateType, PayrollFlagType, PayrollFlagStatus, StaffAttendanceStatus, attendance_staff_daily, zk_attendance_scans } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { auditActorLabel } from '../../../common/utils/audit-actor.util';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { CalendarDayResolverService } from '../calendar/calendar-day-resolver.service';
import { EmployeeExpectedTimesService } from '../../timetables/employee-expected-times.service';
import { StorageService } from '../../../common/storage/storage.service';
import { AttendanceMatrixQueryDto, GeneratePayrollRunDto, ListPayrollRunsQueryDto } from './dto/payroll.dto';
import { DisbursePayrollLineDto, ExcludePayrollLineDto, SettlePayrollLineDto } from './dto/payroll-self.dto';
import { computePayrollWindow } from './payroll-period.util';
import { EmployeeLineColumn, addEmployeeLinesSheet, addMatrixSheet, tagLabels } from './payroll-excel.util';
import { PayslipPdfService } from './payslip-pdf/payslip-pdf.service';
import { EmployeeNoticeBoardService } from '../../employee-notice-board/employee-notice-board.service';
import { PayrollRulesService } from '../payroll-rules/payroll-rules.service';
import { calculateStatutoryContribution, calculateMonthlyIncomeTax } from '../payroll-rules/payroll-tax-calculator.util';
import { SecurityDepositsService } from '../security-deposits/security-deposits.service';
import { EmployeeLoansService } from '../employee-loans/employee-loans.service';

type StaffCalendarRows = Awaited<ReturnType<CalendarDayResolverService['loadStaffCalendarRows']>>;
type AttendanceStaffDailyRow = attendance_staff_daily;

/** Longest date range the live attendance matrix will compute — two pay cycles. */
export const MAX_MATRIX_DAYS = 62;

interface EmployeeLineInput {
  id: number;
  monthly_pay: Prisma.Decimal | null;
  reporting_time: Date | null;
  leaving_time: Date | null;
  late_relaxation_minutes: number | null;
  department_id: number | null;
  staff_category_id: number | null;
  staff_categories: { code: string } | null;
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
  has_salary: boolean;
  is_mapped: boolean;
  has_punches: boolean;
  scheduled_working_days: number;
  total_calendar_days: number;
  present_days: number;
  late_days: number;
  half_days: number;
  absent_days: number;
  excused_days: number;
  unpaid_leave_days: number;
  unresolved_days: number;
  total_break_minutes: number;
  total_late_minutes: number;
  total_overtime_minutes: number;
  overtime_days: number;
  scheduled_minutes_per_day: number;
  monthly_pay: Prisma.Decimal;
  daily_rate: Prisma.Decimal;
  per_minute_rate: Prisma.Decimal;
  absence_deduction: Prisma.Decimal;
  half_day_deduction: Prisma.Decimal;
  late_deduction: Prisma.Decimal;
  break_deduction: Prisma.Decimal;
  eobi_deduction: Prisma.Decimal;
  income_tax_deduction: Prisma.Decimal;
  eobi_employer_cost: Prisma.Decimal;
  sessi_employer_cost: Prisma.Decimal;
  total_deductions: Prisma.Decimal;
  net_pay: Prisma.Decimal;
  daily_breakdown: DayBreakdownEntry[];
}

interface DetectedFlag {
  flag_type: PayrollFlagType;
  anchor_date: string;
  dates: string[];
  deduction_days: number;
}

const NON_WORKED_CLASSIFICATIONS = new Set<DayClassification>([
  'ABSENT',
  'UNPAID_LEAVE',
  'EXCUSED',
  'SICK_LEAVE',
  'CASUAL_LEAVE',
  'ANNUAL_LEAVE',
]);

const runInclude = {
  campuses: { select: { id: true, campus_name: true } },
  payroll_run_lines: {
    include: {
      employee_profiles: {
        select: { id: true, full_name: true, employee_code: true, job_title: true, photo_url: true },
      },
    },
  },
  payroll_flags: true,
  payroll_run_exclusions: {
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
 * Absence deduction = prorated daily rate (monthly_pay / total calendar days
 * in the period — weekends and holidays are paid days off, not a proration
 * base, so every day in the cycle counts toward the divisor even though only
 * working days can ever be marked absent/late). Break deduction = every
 * OUT->IN gap between scan
 * pairs (mirrors the pairing logic in zk-attendance-processor.service.ts /
 * staff-attendance.service.ts#buildDaySegments) at a per-minute rate derived
 * from the employee's own reporting_time/leaving_time window. Both formulas
 * were explicit product decisions, not inferred — see the conversation that
 * produced this module for the alternatives that were rejected.
 */
@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  // Shared by every roster/single-employee lookup that feeds
  // computeEmployeeLinesForRange (generateRun's two roster branches,
  // regenerateLine's single-employee lookup).
  private readonly employeeLineSelect = {
    id: true,
    monthly_pay: true,
    reporting_time: true,
    leaving_time: true,
    late_relaxation_minutes: true,
    department_id: true,
    staff_category_id: true,
    staff_categories: { select: { code: true } },
    days_per_week: true,
    employee_work_schedules: { select: { day_of_week: true, is_working: true } },
  } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly expectedTimes: EmployeeExpectedTimesService,
    private readonly auditLogs: AuditLogsService,
    private readonly storage: StorageService,
    private readonly payslipPdf: PayslipPdfService,
    private readonly employeeNoticeBoard: EmployeeNoticeBoardService,
    private readonly payrollRules: PayrollRulesService,
    private readonly securityDeposits: SecurityDepositsService,
    private readonly employeeLoans: EmployeeLoansService,
  ) {}

  /**
   * Sequences the two discretionary-deduction plans in the agreed priority
   * order — loan first, then caution money — since the deposit pass reads
   * `loan_deduction` back off the line to know how much room it has left.
   */
  private async applyDiscretionaryDeductionsToLine(
    runId: number,
    employeeId: number,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await this.employeeLoans.applySnapshotToLine(runId, employeeId, tx);
    await this.securityDeposits.applySnapshotToLine(runId, employeeId, tx);
  }

  private async commitDiscretionaryDeductions(lineId: number, createdBy: string, tx: Prisma.TransactionClient): Promise<void> {
    await this.employeeLoans.commitLineDeduction(lineId, createdBy, tx);
    await this.securityDeposits.commitLineDeduction(lineId, createdBy, tx);
  }

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

  private async computeEmployeeLine(
    employee: EmployeeLineInput,
    campusId: number,
    periodStart: Date,
    periodEnd: Date,
    calendarRows: StaffCalendarRows,
    attendanceRecords: AttendanceStaffDailyRow[],
    scans: zk_attendance_scans[],
    isMapped: boolean,
    mandatorySaturdayDates?: Set<string>,
    shiftOverridesForEmployee?: Map<string, { start: Date | null; end: Date | null }>,
  ): Promise<ComputedLine> {
    const recordByDate = new Map(attendanceRecords.map((r) => [r.date.toISOString().slice(0, 10), r]));
    const scansByDate = this.groupScansByDate(scans);

    // Cache expected times per weekday — weekly template, identical every week.
    const expectedByDow = new Map<
      number,
      { expectedCheckIn: Date | null; expectedCheckOut: Date | null; graceMinutes: number }
    >();
    for (let dow = 0; dow <= 6; dow++) {
      const synth = new Date(Date.UTC(2024, 0, 7 + dow)); // Sun-Sat week
      const resolvedTimes = await this.expectedTimes.resolveExpectedTimes(
        employee.id,
        campusId,
        synth,
      );
      expectedByDow.set(dow, {
        expectedCheckIn: resolvedTimes.expectedCheckIn,
        expectedCheckOut: resolvedTimes.expectedCheckOut,
        graceMinutes: resolvedTimes.graceMinutes,
      });
    }

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
        employee.staff_category_id,
        employee.staff_categories?.code ?? null,
        employee.days_per_week,
        employee.employee_work_schedules,
        mandatorySaturdayDates,
      );
      const record = recordByDate.get(key);
      const dayScans = scansByDate.get(key) ?? [];
      const breakMinutes = Math.round(this.sumBreakMinutes(dayScans));
      const dowDefault = expectedByDow.get(d.getUTCDay()) ?? {
        expectedCheckIn: employee.reporting_time,
        expectedCheckOut: employee.leaving_time,
        graceMinutes: employee.late_relaxation_minutes ?? 0,
      };
      // Date-specific shift override wins over the weekly-template cache above
      // (which only knows about day-of-week, not this exact date) — merged
      // per-field since a start-only or end-only override still falls
      // through to the normal schedule for the other side of the day.
      const dateOverride = shiftOverridesForEmployee?.get(key);
      const expected = dateOverride
        ? {
            expectedCheckIn: dateOverride.start ?? dowDefault.expectedCheckIn,
            expectedCheckOut: dateOverride.end ?? dowDefault.expectedCheckOut,
            graceMinutes: dowDefault.graceMinutes,
          }
        : dowDefault;

      let classification: DayClassification;
      if (
        record?.source === AttendanceSource.MANUAL ||
        record?.source === AttendanceSource.LEAVE
      ) {
        // A recorded override always wins, even on a holiday/off day — this is
        // what lets HR flip a day off with punches on it to PRESENT/etc.
        classification = record.status as DayClassification;
      } else if (!resolved.isWorkingDay) {
        classification = 'DAY_OFF';
      } else if (dayScans.length === 0) {
        classification = 'ABSENT';
      } else if (dayScans.length % 2 !== 0) {
        classification = 'UNRESOLVED';
      } else if (record?.status === StaffAttendanceStatus.LATE) {
        classification = 'LATE';
      } else {
        classification = 'PRESENT';
      }

      let segments = this.buildDaySegments(dayScans, expected.expectedCheckOut, record ?? null);
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
      if (classification === 'LATE' && checkInAt && expected.expectedCheckIn) {
        const reportingMinutes =
          expected.expectedCheckIn.getUTCHours() * 60 + expected.expectedCheckIn.getUTCMinutes();
        const checkInMinutes = checkInAt.getUTCHours() * 60 + checkInAt.getUTCMinutes();
        const rawLate = checkInMinutes - reportingMinutes;
        const relaxation = expected.graceMinutes;
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
    const totalCalendarDays = dailyBreakdown.length;
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
    // Overtime is read back out of the segments already built above rather
    // than recomputed separately — one classification pass stays the single
    // source of truth for every aggregate, overtime included.
    const totalOvertimeMinutes = dailyBreakdown.reduce((sum, d) => {
      const segs = d.segments ?? [];
      return (
        sum +
        segs
          .filter((s) => s.type === 'OVERTIME')
          .reduce((m, s) => m + Math.max(0, (new Date(s.end).getTime() - new Date(s.start).getTime()) / 60000), 0)
      );
    }, 0);
    // Distinct days on which any overtime was worked — the basis for a
    // per-day overtime reward, as opposed to prorating total minutes into a
    // fractional day count.
    const overtimeDays = dailyBreakdown.filter((d) =>
      (d.segments ?? []).some(
        (s) => s.type === 'OVERTIME' && new Date(s.end).getTime() - new Date(s.start).getTime() > 0,
      ),
    ).length;

    const monthlyPay = new Prisma.Decimal(employee.monthly_pay ?? 0);
    const dailyRate = totalCalendarDays > 0 ? monthlyPay.dividedBy(totalCalendarDays) : new Prisma.Decimal(0);

    // Prefer Mon–Fri derived window average; fall back to profile FIXED times.
    let scheduledMinutes = 0;
    let scheduledDayCount = 0;
    for (let dow = 1; dow <= 5; dow++) {
      const e = expectedByDow.get(dow);
      if (e?.expectedCheckIn && e?.expectedCheckOut) {
        scheduledMinutes += this.scheduledMinutesPerDay(e.expectedCheckIn, e.expectedCheckOut);
        scheduledDayCount++;
      }
    }
    if (scheduledDayCount > 0) {
      scheduledMinutes = Math.round(scheduledMinutes / scheduledDayCount);
    } else {
      scheduledMinutes = this.scheduledMinutesPerDay(employee.reporting_time, employee.leaving_time);
    }
    const perMinuteRate = scheduledMinutes > 0 ? dailyRate.dividedBy(scheduledMinutes) : new Prisma.Decimal(0);

    const absenceDeduction = dailyRate.times(absentDays + unpaidLeaveDays);
    const halfDayDeduction = dailyRate.dividedBy(2).times(halfDays);
    const lateDeduction = perMinuteRate.times(totalLateMinutes);
    const breakDeduction = perMinuteRate.times(totalBreakMinutes);

    const [eobiRule, sessiRule, incomeTaxRule] = await Promise.all([
      this.payrollRules.findEffective('EOBI', periodEnd),
      this.payrollRules.findEffective('SESSI', periodEnd),
      this.payrollRules.findEffective('INCOME_TAX', periodEnd),
    ]);
    const eobiValue = (eobiRule?.value_json ?? {}) as { employer_percent?: number; employee_percent?: number; wage_base_amount?: number };
    const sessiValue = (sessiRule?.value_json ?? {}) as { employer_percent?: number; wage_base_amount?: number };
    const incomeTaxValue = (incomeTaxRule?.value_json ?? {}) as { slabs?: { min: number; max: number | null; fixed_amount: number; rate_percent: number }[] };

    const eobiDeduction = eobiRule
      ? calculateStatutoryContribution(eobiValue.wage_base_amount ?? 0, eobiValue.employee_percent ?? 0)
      : new Prisma.Decimal(0);
    const eobiEmployerCost = eobiRule
      ? calculateStatutoryContribution(eobiValue.wage_base_amount ?? 0, eobiValue.employer_percent ?? 0)
      : new Prisma.Decimal(0);
    const sessiEmployerCost = sessiRule
      ? calculateStatutoryContribution(sessiValue.wage_base_amount ?? 0, sessiValue.employer_percent ?? 0)
      : new Prisma.Decimal(0);
    const incomeTaxDeduction = incomeTaxValue.slabs
      ? calculateMonthlyIncomeTax(monthlyPay.times(12).toNumber(), incomeTaxValue.slabs)
      : new Prisma.Decimal(0);

    const totalDeductions = absenceDeduction
      .plus(halfDayDeduction)
      .plus(lateDeduction)
      .plus(breakDeduction)
      .plus(eobiDeduction)
      .plus(incomeTaxDeduction);
    const netPay = monthlyPay.minus(totalDeductions);

    return {
      has_salary: employee.monthly_pay != null && !employee.monthly_pay.isZero(),
      is_mapped: isMapped,
      has_punches: scans.length > 0,
      scheduled_working_days: scheduledWorkingDays,
      total_calendar_days: totalCalendarDays,
      present_days: presentDays,
      late_days: lateDays,
      half_days: halfDays,
      absent_days: absentDays,
      excused_days: excusedDays,
      unpaid_leave_days: unpaidLeaveDays,
      unresolved_days: unresolvedDays,
      total_break_minutes: totalBreakMinutes,
      total_late_minutes: totalLateMinutes,
      total_overtime_minutes: Math.round(totalOvertimeMinutes),
      overtime_days: overtimeDays,
      // Standard 8h workday only when this employee's schedule can't be
      // resolved at all — used solely as the "1 day" divisor for a
      // per-day overtime reward rate at settlement time.
      scheduled_minutes_per_day: Math.round(scheduledMinutes) || 480,
      monthly_pay: monthlyPay.toDecimalPlaces(2),
      daily_rate: dailyRate.toDecimalPlaces(2),
      per_minute_rate: perMinuteRate.toDecimalPlaces(4),
      absence_deduction: absenceDeduction.toDecimalPlaces(2),
      half_day_deduction: halfDayDeduction.toDecimalPlaces(2),
      late_deduction: lateDeduction.toDecimalPlaces(2),
      break_deduction: breakDeduction.toDecimalPlaces(2),
      eobi_deduction: eobiDeduction,
      income_tax_deduction: incomeTaxDeduction,
      eobi_employer_cost: eobiEmployerCost,
      sessi_employer_cost: sessiEmployerCost,
      total_deductions: totalDeductions.toDecimalPlaces(2),
      net_pay: netPay.toDecimalPlaces(2),
      daily_breakdown: dailyBreakdown,
    };
  }

  /**
   * Neither rule is ever auto-applied — this only detects candidate
   * instances from the ordered dailyBreakdown so they can be surfaced to an
   * admin for an explicit Apply/Exempt decision. See finalizeRun, which
   * blocks while any detected flag is still PENDING.
   *
   * Sandwich: any run of one or more consecutive non-working days — a
   * declared HOLIDAY, an ordinary WEEKEND, or a mix of both back to back —
   * becomes a candidate whenever the nearest working day on BOTH sides
   * (skipping other non-working days) was not worked (absent, unpaid
   * leave, or any approved leave). There's no minimum or maximum block
   * length: a single bracketed Sunday qualifies exactly like a 4-day
   * holiday-plus-weekend stretch — the whole off-block becomes unpaid.
   *
   * Consecutive-late: walks working days in order, skipping non-working
   * days (they don't break a streak); any late streak flushes into one flag
   * per streak with deduction_days = floor(streakLength / 3) — the mod-3
   * remainder (1-2 stray lates) never counts.
   */
  // Temporarily disabled — do not detect new 3-consecutive-late flags at all.
  // Flip back to true to re-enable; sandwich detection is untouched either way.
  private readonly CONSECUTIVE_LATE_RULE_ENABLED = false;

  private detectPayrollFlags(dailyBreakdown: DayBreakdownEntry[]): DetectedFlag[] {
    const flags: DetectedFlag[] = [];

    let i = 0;
    while (i < dailyBreakdown.length) {
      if (!dailyBreakdown[i].is_working_day) {
        let j = i;
        while (j < dailyBreakdown.length && !dailyBreakdown[j].is_working_day) j++;
        const runLength = j - i;
        let beforeIdx = i - 1;
        while (beforeIdx >= 0 && !dailyBreakdown[beforeIdx].is_working_day) beforeIdx--;
        let afterIdx = j;
        while (afterIdx < dailyBreakdown.length && !dailyBreakdown[afterIdx].is_working_day) afterIdx++;
        const before = beforeIdx >= 0 ? dailyBreakdown[beforeIdx] : null;
        const after = afterIdx < dailyBreakdown.length ? dailyBreakdown[afterIdx] : null;
        if (
          before &&
          after &&
          NON_WORKED_CLASSIFICATIONS.has(before.classification) &&
          NON_WORKED_CLASSIFICATIONS.has(after.classification)
        ) {
          const dates = dailyBreakdown.slice(i, j).map((d) => d.date);
          flags.push({ flag_type: PayrollFlagType.SANDWICH, anchor_date: dates[0], dates, deduction_days: runLength });
        }
        i = j;
      } else {
        i++;
      }
    }

    if (this.CONSECUTIVE_LATE_RULE_ENABLED) {
      let streakDates: string[] = [];
      const flushLateStreak = () => {
        const groups = Math.floor(streakDates.length / 3);
        if (groups >= 1) {
          const dates = streakDates.slice(0, groups * 3);
          flags.push({ flag_type: PayrollFlagType.CONSECUTIVE_LATE, anchor_date: dates[0], dates, deduction_days: groups });
        }
        streakDates = [];
      };
      for (const day of dailyBreakdown) {
        if (!day.is_working_day) continue;
        if (day.classification === 'LATE') {
          streakDates.push(day.date);
        } else {
          flushLateStreak();
        }
      }
      flushLateStreak();
    }

    return flags;
  }

  /**
   * Upserts detected flags for one employee on a run, keyed by
   * (run, employee, type, anchor_date) so an admin's Apply/Exempt decision
   * survives a DRAFT regenerate even though the underlying line gets a new
   * id. Stale flags (no longer detected) are deleted, then the line's flag
   * deduction columns are recomputed from whatever APPLIED flags remain.
   */
  private async syncPayrollFlagsForEmployee(
    runId: number,
    employeeId: number,
    detected: DetectedFlag[],
    dailyRate: Prisma.Decimal,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const existingFlags = await tx.payroll_flags.findMany({
      where: { payroll_run_id: runId, employee_id: employeeId },
    });
    const existingByKey = new Map(
      existingFlags.map((f) => [`${f.flag_type}:${f.anchor_date.toISOString().slice(0, 10)}`, f]),
    );
    const seenKeys = new Set<string>();

    for (const flag of detected) {
      const key = `${flag.flag_type}:${flag.anchor_date}`;
      seenKeys.add(key);
      const deductionAmount = dailyRate.times(flag.deduction_days).toDecimalPlaces(2);
      const existing = existingByKey.get(key);
      if (existing) {
        await tx.payroll_flags.update({
          where: { id: existing.id },
          data: { dates: flag.dates, deduction_days: flag.deduction_days, deduction_amount: deductionAmount },
        });
      } else {
        await tx.payroll_flags.create({
          data: {
            payroll_run_id: runId,
            employee_id: employeeId,
            flag_type: flag.flag_type,
            anchor_date: new Date(`${flag.anchor_date}T00:00:00.000Z`),
            dates: flag.dates,
            deduction_days: flag.deduction_days,
            deduction_amount: deductionAmount,
          },
        });
      }
    }

    const staleIds = existingFlags
      .filter((f) => !seenKeys.has(`${f.flag_type}:${f.anchor_date.toISOString().slice(0, 10)}`))
      .map((f) => f.id);
    if (staleIds.length > 0) {
      await tx.payroll_flags.deleteMany({ where: { id: { in: staleIds } } });
    }

    await this.recomputeLineFlagDeductions(runId, employeeId, tx);
  }

  /**
   * The four base deductions (absence/half-day/late/break) stay exactly as
   * computeEmployeeLine produced them — flag deductions are an additive
   * layer folded in only from flags currently APPLIED, so a PENDING or
   * EXEMPTED flag never changes pay. Discretionary installments (security
   * deposit today; employee loans later, applied first) are then capped so
   * they never push net below zero; any shortfall carries to the next cycle.
   */
  private async recomputeLineFlagDeductions(
    runId: number,
    employeeId: number,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const line = await tx.payroll_run_lines.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
    });
    if (!line) return;

    const [sandwichSum, lateSum] = await Promise.all([
      tx.payroll_flags.aggregate({
        where: { payroll_run_id: runId, employee_id: employeeId, flag_type: PayrollFlagType.SANDWICH, status: PayrollFlagStatus.APPLIED },
        _sum: { deduction_amount: true },
      }),
      tx.payroll_flags.aggregate({
        where: { payroll_run_id: runId, employee_id: employeeId, flag_type: PayrollFlagType.CONSECUTIVE_LATE, status: PayrollFlagStatus.APPLIED },
        _sum: { deduction_amount: true },
      }),
    ]);

    const sandwichDeduction = new Prisma.Decimal(sandwichSum._sum.deduction_amount ?? 0).toDecimalPlaces(2);
    const consecutiveLateDeduction = new Prisma.Decimal(lateSum._sum.deduction_amount ?? 0).toDecimalPlaces(2);

    await tx.payroll_run_lines.update({
      where: { id: line.id },
      data: {
        sandwich_deduction: sandwichDeduction,
        consecutive_late_deduction: consecutiveLateDeduction,
      },
    });
    await this.applyDiscretionaryDeductionsToLine(runId, employeeId, tx);
  }

  /**
   * Validates the run is still a DRAFT, applies the admin's Apply/Exempt
   * decision to one flag, and folds it into the line's pay. Endpoint for
   * the Flag Review panel — see PayrollController.
   */
  async decidePayrollFlag(
    runId: number,
    employeeId: number,
    flagId: number,
    status: 'APPLIED' | 'EXEMPTED',
    user: IJwtStaffPayload,
  ) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);

    const line = await this.prisma.payroll_run_lines.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
      select: { finalized_at: true },
    });
    if (line?.finalized_at) {
      throw new BadRequestException("Flags can only be decided before this employee's payroll line is finalized.");
    }

    const flag = await this.prisma.payroll_flags.findUnique({ where: { id: flagId } });
    if (!flag || flag.payroll_run_id !== runId || flag.employee_id !== employeeId) {
      throw new NotFoundException('Payroll flag not found on this run for this employee.');
    }

    await this.prisma.payroll_flags.update({
      where: { id: flagId },
      data: { status: status as PayrollFlagStatus, decided_by: user.sub, decided_at: new Date() },
    });
    await this.recomputeLineFlagDeductions(runId, employeeId);

    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(runId),
      action: 'FLAG_DECIDED',
      field: 'flag_id',
      new_value: String(flagId),
      changed_by: auditActorLabel(user),
      note: `${flag.flag_type} flag (${(flag.dates as string[]).join(', ')}) for employee ${employeeId} marked ${status}.`,
    });

    return this.getRun(runId, user);
  }

  // Shared by generateRun (persists a snapshot) and getAttendanceMatrix (reads
  // live, nothing persisted) — everything is loaded once for the whole batch
  // (not once per employee, let alone once per employee per day) and matched
  // in memory; a single employee-by-employee query loop here took minutes
  // over the network round-trip cost to the remote DB.
  private async computeEmployeeLinesForRange(
    employees: EmployeeLineInput[],
    campusId: number,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<(ComputedLine & { employee_id: number })[]> {
    const employeeIds = employees.map((e) => e.id);
    const [calendarRows, mandatoryByEmployee, shiftOverridesByEmployee, allAttendanceRecords, allScans, mappedRows] = await Promise.all([
      this.calendarResolver.loadStaffCalendarRows(campusId, periodStart, periodEnd),
      this.calendarResolver.loadMandatorySaturdayDatesForEmployees(employeeIds, periodStart, periodEnd),
      this.expectedTimes.loadShiftOverridesForEmployees(employeeIds, periodStart, periodEnd),
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
      // Mapping isn't date-scoped (a device_user_mappings row either exists or
      // doesn't) — used for the "Not Mapped" / "No Punches" tags.
      this.prisma.device_user_mappings.findMany({
        where: { employee_id: { in: employeeIds }, person_type: 'STAFF', is_active: true },
        select: { employee_id: true },
      }),
    ]);
    const mappedEmployeeIds = new Set(mappedRows.map((m) => m.employee_id));

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

    return Promise.all(
      employees.map(async (employee) => ({
        employee_id: employee.id,
        ...(await this.computeEmployeeLine(
          employee,
          campusId,
          periodStart,
          periodEnd,
          calendarRows,
          attendanceByEmployee.get(employee.id) ?? [],
          scansByEmployee.get(employee.id) ?? [],
          mappedEmployeeIds.has(employee.id),
          mandatoryByEmployee.get(employee.id) ?? new Set<string>(),
          shiftOverridesByEmployee.get(employee.id),
        )),
      })),
    );
  }

  /**
   * Regenerates exactly one employee's line on an existing run — the
   * employee-scoped counterpart to generateRun's "Regen All". Reuses the same
   * computeEmployeeLinesForRange/syncPayrollFlagsForEmployee machinery,
   * called with a single-employee roster, and upserts (never delete+recreate)
   * so the line keeps its id.
   */
  async regenerateLine(runId: number, employeeId: number, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);
    if (run.is_test) {
      throw new BadRequestException('Test runs do not support per-employee regenerate — use "Generate Test Run" instead.');
    }

    const existingLine = await this.prisma.payroll_run_lines.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
      select: { finalized_at: true },
    });
    if (existingLine?.finalized_at) {
      throw new BadRequestException("This employee's payroll line is already finalized and cannot be regenerated.");
    }

    const excluded = await this.prisma.payroll_run_exclusions.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
      select: { id: true },
    });
    if (excluded) {
      throw new BadRequestException('This employee is excluded from this payroll run — use "Include" to bring them back first.');
    }

    const employee = await this.prisma.employee_profiles.findFirst({
      where: { id: employeeId, campus_id: run.campus_id, monthly_pay: { not: null } },
      select: this.employeeLineSelect,
    });
    if (!employee) {
      throw new BadRequestException("This employee is not on this run's campus, or has no monthly_pay set.");
    }

    const [{ employee_id, ...lineData }] = await this.computeEmployeeLinesForRange(
      [employee],
      run.campus_id,
      run.period_start,
      run.period_end,
    );
    const detected = this.detectPayrollFlags(lineData.daily_breakdown);

    await this.prisma.$transaction(async (tx) => {
      await tx.payroll_run_lines.upsert({
        where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id } },
        create: { payroll_run_id: runId, employee_id, ...lineData } as unknown as Prisma.payroll_run_linesCreateInput,
        update: lineData as unknown as Prisma.payroll_run_linesUpdateInput,
      });
      await this.syncPayrollFlagsForEmployee(runId, employee_id, detected, lineData.daily_rate, tx);
      await this.recomputeRunStatus(runId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(runId),
      action: 'LINE_REGENERATED',
      field: 'employee_id',
      new_value: String(employeeId),
      changed_by: auditActorLabel(user),
      note: `Regenerated payroll line for employee ${employeeId}.`,
    });

    return this.getRun(runId, user);
  }

  /**
   * Finalizes (locks) exactly one employee's line, independent of the rest
   * of the run — the employee-scoped counterpart to finalizeRun's "Finalize
   * All". A cycle only rolls up to FINALIZED (see recomputeRunStatus) once
   * every employee has gone through here.
   */
  async finalizeLine(runId: number, employeeId: number, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);
    if (run.is_test) {
      throw new BadRequestException('Test runs do not support per-employee finalize — use "Finalize All" instead.');
    }

    const line = await this.prisma.payroll_run_lines.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
      include: { employee_profiles: { select: { user_id: true } } },
    });
    if (!line) throw new NotFoundException(`Payroll line for employee ${employeeId} not found on run ${runId}`);
    if (line.finalized_at) {
      throw new BadRequestException("This employee's payroll line is already finalized.");
    }
    if (line.unresolved_days > 0) {
      throw new BadRequestException(
        `Cannot finalize: ${line.unresolved_days} unresolved attendance day(s) for this employee ` +
          `(working days with no attendance record at all). Resolve them in the staff attendance register, ` +
          `then regenerate this line.`,
      );
    }
    const pendingFlags = await this.prisma.payroll_flags.count({
      where: { payroll_run_id: runId, employee_id: employeeId, status: PayrollFlagStatus.PENDING },
    });
    if (pendingFlags > 0) {
      throw new BadRequestException(
        `Cannot finalize: ${pendingFlags} flagged instance(s) of the sandwich or consecutive-late rules ` +
          `still need a decision (Apply or Exempt) for this employee.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.applyDiscretionaryDeductionsToLine(runId, employeeId, tx);
      await tx.payroll_run_lines.update({
        where: { id: line.id },
        data: { finalized_at: new Date(), finalized_by: user.sub },
      });
      await this.commitDiscretionaryDeductions(line.id, user.sub, tx);
      await this.recomputeRunStatus(runId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(runId),
      action: 'LINE_FINALIZED',
      field: 'employee_id',
      new_value: String(employeeId),
      changed_by: auditActorLabel(user),
      note: `Finalized payroll line for employee ${employeeId}.`,
    });

    // Test runs are throwaway/repeatable — no reason to page a test employee
    // every time one gets finalized during testing. (run.is_test is already
    // rejected above, kept for parity with finalizeRun's notification guard.)
    if (!run.is_test && line.employee_profiles.user_id) {
      const periodLabel = `${run.period_start.toISOString().slice(0, 10)} to ${run.period_end.toISOString().slice(0, 10)}`;
      void this.employeeNoticeBoard
        .createPayrollNotice(employeeId, line.employee_profiles.user_id, 'Payroll finalized', `Your payroll for ${periodLabel} has been finalized.`, runId)
        .catch((err) => this.logger.error(`Failed to send payroll-finalized notice for employee ${employeeId}`, err));
    }

    return this.getRun(runId, user);
  }

  /**
   * Removes one employee from a still-pending payroll cycle — e.g. their
   * attendance wasn't reliably tracked this period, so their numbers
   * shouldn't be computed (or paid) yet. Deletes their line (and any flags,
   * which aren't cascade-linked to the line — see syncPayrollFlagsForEmployee)
   * and records the exclusion so "Regen All" and per-employee regenerate
   * leave them out until an explicit "Include" reverses it.
   */
  async excludeLine(runId: number, employeeId: number, dto: ExcludePayrollLineDto, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);
    if (run.is_test) {
      throw new BadRequestException('Test runs do not support excluding employees.');
    }

    const line = await this.prisma.payroll_run_lines.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
      select: { id: true, finalized_at: true },
    });
    if (line?.finalized_at) {
      throw new BadRequestException("This employee's payroll line is already finalized and cannot be excluded.");
    }

    await this.prisma.$transaction(async (tx) => {
      if (line) {
        await tx.payroll_run_lines.delete({ where: { id: line.id } });
      }
      await tx.payroll_flags.deleteMany({ where: { payroll_run_id: runId, employee_id: employeeId } });
      await tx.payroll_run_exclusions.upsert({
        where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
        create: { payroll_run_id: runId, employee_id: employeeId, reason: dto.reason ?? null, excluded_by: user.sub },
        update: { reason: dto.reason ?? null, excluded_by: user.sub, excluded_at: new Date() },
      });
      await this.recomputeRunStatus(runId, tx);
    });

    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(runId),
      action: 'LINE_EXCLUDED',
      field: 'employee_id',
      new_value: String(employeeId),
      changed_by: auditActorLabel(user),
      note: [`Excluded employee ${employeeId} from this payroll run.`, dto.reason].filter(Boolean).join(' '),
    });

    return this.getRun(runId, user);
  }

  /** Reverses excludeLine — re-computes the employee's line and removes the exclusion record. */
  async includeLine(runId: number, employeeId: number, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);

    const exclusion = await this.prisma.payroll_run_exclusions.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
    });
    if (!exclusion) {
      throw new NotFoundException('This employee is not excluded from this payroll run.');
    }

    const employee = await this.prisma.employee_profiles.findFirst({
      where: { id: employeeId, campus_id: run.campus_id, monthly_pay: { not: null } },
      select: this.employeeLineSelect,
    });

    if (!employee) {
      // No longer payroll-eligible (e.g. left, or monthly_pay cleared) — just
      // lift the exclusion, there's nothing to compute a line from.
      await this.prisma.payroll_run_exclusions.delete({ where: { id: exclusion.id } });
      await this.recomputeRunStatus(runId);
    } else {
      const [{ employee_id, ...lineData }] = await this.computeEmployeeLinesForRange(
        [employee],
        run.campus_id,
        run.period_start,
        run.period_end,
      );
      const detected = this.detectPayrollFlags(lineData.daily_breakdown);

      await this.prisma.$transaction(async (tx) => {
        await tx.payroll_run_lines.upsert({
          where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id } },
          create: { payroll_run_id: runId, employee_id, ...lineData } as unknown as Prisma.payroll_run_linesCreateInput,
          update: lineData as unknown as Prisma.payroll_run_linesUpdateInput,
        });
        await this.syncPayrollFlagsForEmployee(runId, employee_id, detected, lineData.daily_rate, tx);
        await tx.payroll_run_exclusions.delete({ where: { id: exclusion.id } });
        await this.recomputeRunStatus(runId, tx);
      });
    }

    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(runId),
      action: 'LINE_INCLUDED',
      field: 'employee_id',
      new_value: String(employeeId),
      changed_by: auditActorLabel(user),
      note: `Re-included employee ${employeeId} on this payroll run.`,
    });

    return this.getRun(runId, user);
  }

  async generateRun(dto: GeneratePayrollRunDto, user: IJwtStaffPayload) {
    this.assertCampusAccess(user, dto.campus_id);

    const { periodStart, periodEnd } = this.computePayrollWindow(dto.year, dto.month);

    // Presence of employee_ids is what makes this a TEST run — scoped to
    // just those employees instead of every paid employee on the campus.
    const isTest = !!dto.employee_ids?.length;

    const employees = isTest
      ? await this.prisma.employee_profiles.findMany({
          where: { id: { in: dto.employee_ids }, campus_id: dto.campus_id, monthly_pay: { not: null } },
          select: this.employeeLineSelect,
        })
      : await this.prisma.employee_profiles.findMany({
          where: {
            campus_id: dto.campus_id,
            monthly_pay: { not: null },
            employment_status: { in: ['ACTIVE', 'PERMANENT'] },
          },
          select: this.employeeLineSelect,
        });
    if (employees.length === 0) {
      throw new BadRequestException(
        isTest
          ? 'None of the selected employees belong to this campus with a monthly_pay set — nothing to calculate.'
          : 'No employees on this campus have a monthly_pay set yet — nothing to calculate.',
      );
    }
    if (isTest && employees.length !== dto.employee_ids!.length) {
      throw new BadRequestException(
        'One or more selected employees are not on this campus or have no monthly_pay set — a test run can only include valid, payable employees.',
      );
    }

    const existing = await this.prisma.payroll_runs.findUnique({
      where: {
        campus_id_period_start_period_end_is_test: {
          campus_id: dto.campus_id,
          period_start: periodStart,
          period_end: periodEnd,
          is_test: isTest,
        },
      },
    });
    // Re-generating for the same period replaces it in place (recomputed from
    // current attendance data) rather than piling up duplicate drafts —
    // expected while real attendance data is still being backfilled. For a
    // test run this also applies even if it was previously finalized. A real
    // run that's fully complete (every line finalized) is no longer a hard
    // block either — see the "Regen All" branch below, which simply has
    // nothing left to touch in that case.
    const run = existing
      ? await this.prisma.payroll_runs.update({
          where: { id: existing.id },
          data: {
            notes: dto.notes,
            generated_by: user.sub,
            generated_at: new Date(),
            ...(existing.is_test && existing.status === PayrollRunStatus.FINALIZED
              ? { status: PayrollRunStatus.DRAFT, finalized_at: null }
              : {}),
          },
        })
      : await this.prisma.payroll_runs.create({
          data: {
            campus_id: dto.campus_id,
            period_start: periodStart,
            period_end: periodEnd,
            notes: dto.notes,
            generated_by: user.sub,
            is_test: isTest,
          },
        });

    let touchedCount = employees.length;

    if (!existing || isTest) {
      // New run, or a test-run regenerate: test runs stay fully disposable —
      // the whole point of test mode is being able to repeat generate ->
      // finalize -> settle as many times as needed — so both cases wipe (if
      // anything exists) and recompute the entire given roster from scratch.
      if (existing) {
        await this.prisma.payroll_run_lines.deleteMany({ where: { payroll_run_id: run.id } });
      }
      const computedLines = await this.computeEmployeeLinesForRange(employees, dto.campus_id, periodStart, periodEnd);
      await this.prisma.payroll_run_lines.createMany({
        data: computedLines.map((line) => ({ payroll_run_id: run.id, ...line })) as unknown as Prisma.payroll_run_linesCreateManyInput[],
      });
      for (const line of computedLines) {
        const detected = this.detectPayrollFlags(line.daily_breakdown);
        await this.syncPayrollFlagsForEmployee(run.id, line.employee_id, detected, line.daily_rate);
      }
    } else {
      // "Regen All" on a real run: never touch an employee whose line is
      // already finalized/settled, or who's been deliberately excluded (see
      // excludeLine) — everyone else (including a newly eligible employee
      // with no line here yet, e.g. a new hire) is upserted in place. Upsert
      // keeps an existing line's id, so it never orphans a payroll_settlements
      // row or reshuffles payroll_flags identity the way delete+recreate did.
      const [existingLines, exclusions] = await Promise.all([
        this.prisma.payroll_run_lines.findMany({
          where: { payroll_run_id: run.id },
          select: { employee_id: true, finalized_at: true },
        }),
        this.prisma.payroll_run_exclusions.findMany({
          where: { payroll_run_id: run.id },
          select: { employee_id: true },
        }),
      ]);
      const lockedIds = new Set(existingLines.filter((l) => l.finalized_at).map((l) => l.employee_id));
      const excludedIds = new Set(exclusions.map((e) => e.employee_id));
      const toCompute = employees.filter((e) => !lockedIds.has(e.id) && !excludedIds.has(e.id));
      touchedCount = toCompute.length;

      if (toCompute.length > 0) {
        const computedLines = await this.computeEmployeeLinesForRange(toCompute, dto.campus_id, periodStart, periodEnd);
        for (const { employee_id, ...lineData } of computedLines) {
          await this.prisma.payroll_run_lines.upsert({
            where: { payroll_run_id_employee_id: { payroll_run_id: run.id, employee_id } },
            create: { payroll_run_id: run.id, employee_id, ...lineData } as unknown as Prisma.payroll_run_linesCreateInput,
            update: lineData as unknown as Prisma.payroll_run_linesUpdateInput,
          });
          const detected = this.detectPayrollFlags(lineData.daily_breakdown);
          await this.syncPayrollFlagsForEmployee(run.id, employee_id, detected, lineData.daily_rate);
        }
      }
      await this.recomputeRunStatus(run.id);
    }

    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(run.id),
      action: existing ? 'UPDATED' : 'CREATED',
      field: 'status',
      new_value: isTest ? 'DRAFT_TEST' : 'DRAFT',
      changed_by: auditActorLabel(user),
      note: `${existing ? 'Regenerated' : 'Generated'} payroll run for campus ${dto.campus_id}, ${dto.year}-${String(dto.month).padStart(2, '0')} (${touchedCount} of ${employees.length} employee(s) touched${isTest ? ', test' : ''}).`,
    });

    return this.getRun(run.id, user);
  }

  /**
   * Same per-day classification as a payroll run's punch-card matrix, but
   * live and read-only — no payroll_runs/payroll_run_lines row is written.
   * Lets HR see attendance for an arbitrary date range (e.g. the HR
   * dashboard) without first generating a payroll run for that period.
   */
  private parseMatrixPeriod(periodStartStr: string, periodEndStr: string): { periodStart: Date; periodEnd: Date } {
    const periodStart = new Date(`${periodStartStr}T00:00:00.000Z`);
    const periodEnd = new Date(`${periodEndStr}T00:00:00.000Z`);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime()) || periodStart > periodEnd) {
      throw new BadRequestException('Invalid period_start/period_end');
    }
    // The matrix renders one column per day, and daily_breakdown carries one
    // object per employee per day — an unbounded range is a payload and
    // render bomb. Two pay cycles is well past any real use of this view.
    const days = Math.floor((periodEnd.getTime() - periodStart.getTime()) / 86_400_000) + 1;
    if (days > MAX_MATRIX_DAYS) {
      throw new BadRequestException(`Date range too large — pick ${MAX_MATRIX_DAYS} days or fewer.`);
    }
    return { periodStart, periodEnd };
  }

  // campus_id omitted -> "all employees" view: a campus-scoped user (has
  // user.campusId) is pinned to their own campus regardless; only a
  // multi-campus user (SUPER_ADMIN, user.campusId null) actually sees
  // every campus combined.
  private async resolveMatrixCampusIds(user: IJwtStaffPayload, requestedCampusId?: number): Promise<number[]> {
    if (requestedCampusId != null) {
      this.assertCampusAccess(user, requestedCampusId);
      return [requestedCampusId];
    }
    if (user.campusId != null) return [user.campusId];
    const campuses = await this.prisma.campuses.findMany({ where: { is_active: true }, select: { id: true } });
    return campuses.map((c) => c.id);
  }

  private async computeMatrixLinesForCampus(
    campusId: number,
    periodStart: Date,
    periodEnd: Date,
    departmentIds?: number[],
  ) {
    const [campus, employees] = await Promise.all([
      this.prisma.campuses.findUnique({ where: { id: campusId }, select: { campus_name: true } }),
      this.prisma.employee_profiles.findMany({
        where: {
          campus_id: campusId,
          // Matches generateRun's employee scope — terminated staff have no
          // attendance to show and only inflate the matrix.
          employment_status: { in: ['ACTIVE', 'PERMANENT'] },
          ...(departmentIds?.length ? { department_id: { in: departmentIds } } : {}),
        },
        select: {
          id: true,
          full_name: true,
          employee_code: true,
          job_title: true,
          photo_url: true,
          monthly_pay: true,
          reporting_time: true,
          leaving_time: true,
          late_relaxation_minutes: true,
          department_id: true,
          staff_category_id: true,
          staff_categories: { select: { code: true } },
          days_per_week: true,
          employee_work_schedules: { select: { day_of_week: true, is_working: true } },
        },
      }),
    ]);

    const computedLines = await this.computeEmployeeLinesForRange(employees, campusId, periodStart, periodEnd);
    const employeeById = new Map(employees.map((e) => [e.id, e]));

    return computedLines.map((line) => {
      const employee = employeeById.get(line.employee_id)!;
      return {
        employee_id: line.employee_id,
        campus_id: campusId,
        campus_name: campus?.campus_name ?? `Campus #${campusId}`,
        employee_profiles: {
          id: employee.id,
          full_name: employee.full_name,
          employee_code: employee.employee_code,
          job_title: employee.job_title,
          photo_url: employee.photo_url,
        },
        has_salary: line.has_salary,
        is_mapped: line.is_mapped,
        has_punches: line.has_punches,
        present_days: line.present_days,
        late_days: line.late_days,
        half_days: line.half_days,
        absent_days: line.absent_days,
        excused_days: line.excused_days,
        unpaid_leave_days: line.unpaid_leave_days,
        unresolved_days: line.unresolved_days,
        total_break_minutes: line.total_break_minutes,
        total_late_minutes: line.total_late_minutes,
        daily_breakdown: line.daily_breakdown,
      };
    });
  }

  async getAttendanceMatrix(query: AttendanceMatrixQueryDto, user: IJwtStaffPayload) {
    const { periodStart, periodEnd } = this.parseMatrixPeriod(query.period_start, query.period_end);
    const campusIds = await this.resolveMatrixCampusIds(user, query.campus_id);

    const perCampusLines = await Promise.all(
      campusIds.map((campusId) =>
        this.computeMatrixLinesForCampus(campusId, periodStart, periodEnd, query.department_id),
      ),
    );

    return {
      campus_id: query.campus_id ?? null,
      period_start: query.period_start,
      period_end: query.period_end,
      lines: perCampusLines.flat(),
    };
  }

  // Mirrors the webpage exactly: sheet 1 is the same columns as the
  // Employee Lines table, sheet 2 is the same day-by-day punch card matrix,
  // color-coded to match. Includes a Campus column only when the request
  // spans more than one campus (i.e. no specific campus_id was requested).
  async exportAttendanceMatrix(query: AttendanceMatrixQueryDto, user: IJwtStaffPayload): Promise<Buffer> {
    const matrix = await this.getAttendanceMatrix(query, user);
    const includeCampusColumn = query.campus_id == null;
    type Line = (typeof matrix.lines)[number];

    const columns: EmployeeLineColumn<Line>[] = [
      { header: 'Employee', width: 26, getValue: (l) => l.employee_profiles?.full_name ?? `Employee #${l.employee_id}` },
      { header: 'Code', width: 14, getValue: (l) => l.employee_profiles?.employee_code ?? '' },
    ];
    if (includeCampusColumn) {
      columns.push({ header: 'Campus', width: 20, getValue: (l) => l.campus_name ?? '' });
    }
    columns.push(
      { header: 'Present', width: 10, getValue: (l) => l.present_days },
      { header: 'Absent / Unpaid', width: 16, getValue: (l) => l.absent_days + (l.unpaid_leave_days ?? 0) },
      { header: 'Unresolved', width: 12, getValue: (l) => l.unresolved_days },
      { header: 'Late (min)', width: 12, getValue: (l) => l.total_late_minutes },
      { header: 'Break (min)', width: 12, getValue: (l) => l.total_break_minutes },
      { header: 'Tags', width: 24, getValue: (l) => tagLabels(l) },
    );

    const workbook = new ExcelJS.Workbook();
    addEmployeeLinesSheet(workbook, matrix.lines, columns);
    addMatrixSheet(workbook, matrix.lines, matrix.period_start, matrix.period_end, includeCampusColumn);

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  // Same sheet layout as exportAttendanceMatrix, but with the full financial
  // columns a persisted payroll run's Employee Lines table shows — single
  // campus by construction (a run is always generated per-campus).
  async exportRun(id: number, user: IJwtStaffPayload): Promise<Buffer> {
    const run = await this.getRun(id, user);
    // daily_breakdown is stored as Json — it's always a DayBreakdownEntry[]
    // (written by computeEmployeeLine), just not typed that way by Prisma.
    type Line = Omit<(typeof run.payroll_run_lines)[number], 'daily_breakdown'> & { daily_breakdown: DayBreakdownEntry[] };
    const lines = run.payroll_run_lines as unknown as Line[];

    const columns: EmployeeLineColumn<Line>[] = [
      { header: 'Employee', width: 26, getValue: (l) => l.employee_profiles?.full_name ?? `Employee #${l.employee_id}` },
      { header: 'Code', width: 14, getValue: (l) => l.employee_profiles?.employee_code ?? '' },
      { header: 'Present', width: 10, getValue: (l) => l.present_days },
      { header: 'Absent / Unpaid', width: 16, getValue: (l) => l.absent_days + (l.unpaid_leave_days ?? 0) },
      { header: 'Unresolved', width: 12, getValue: (l) => l.unresolved_days },
      { header: 'Late (min)', width: 12, getValue: (l) => l.total_late_minutes },
      { header: 'Break (min)', width: 12, getValue: (l) => l.total_break_minutes },
      { header: 'Daily Rate', width: 14, getValue: (l) => Number(l.daily_rate) },
      { header: 'Total Pay', width: 14, getValue: (l) => Number(l.monthly_pay) },
      { header: 'Loan', width: 16, getValue: (l) => Number(l.loan_deduction) },
      { header: 'Security Deposit', width: 16, getValue: (l) => Number(l.security_deposit_deduction) },
      { header: 'Deductions', width: 14, getValue: (l) => Number(l.total_deductions) },
      { header: 'Net Pay', width: 14, getValue: (l) => Number(l.net_pay) },
      { header: 'Tags', width: 24, getValue: (l) => tagLabels(l) },
    ];
    if (lines.some((l) => l.disbursed_at)) {
      columns.push({
        header: 'Disbursed',
        width: 16,
        getValue: (l) => (l.disbursed_at ? l.disbursed_at.toISOString().slice(0, 10) : ''),
      });
    }
    if (lines.some((l) => l.finalized_at)) {
      columns.push({
        header: 'Finalized',
        width: 16,
        getValue: (l) => (l.finalized_at ? l.finalized_at.toISOString().slice(0, 10) : ''),
      });
    }

    const workbook = new ExcelJS.Workbook();
    addEmployeeLinesSheet(workbook, lines, columns);
    addMatrixSheet(
      workbook,
      lines,
      run.period_start.toISOString().slice(0, 10),
      run.period_end.toISOString().slice(0, 10),
      false,
    );

    return Buffer.from(await workbook.xlsx.writeBuffer());
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
    return this.attachDerivedFieldsToLines(run);
  }

  /**
   * Per-line status is derived, never stored: a line moves
   * PENDING -> FINALIZED (finalized_at set, locked against regenerate) ->
   * SETTLED (disbursed_at set, via settleLine or the legacy disburseLine/
   * disburseAll paths). A run-level "complete" rollup is a separate concern,
   * see recomputeRunStatus.
   */
  private deriveLineStatus(line: { finalized_at: Date | null; disbursed_at: Date | null }): 'PENDING' | 'FINALIZED' | 'SETTLED' {
    if (line.disbursed_at) return 'SETTLED';
    if (line.finalized_at) return 'FINALIZED';
    return 'PENDING';
  }

  /**
   * A pay cycle is "complete" (payroll_runs.status = FINALIZED) once every
   * employee line on it has finalized_at set — no one left pending — and
   * "incomplete" (DRAFT) otherwise. Called as a side effect of every mutation
   * that can change a line's finalized_at, so the run-level badge always
   * reflects the current rollup rather than being a manually-flipped switch.
   * lines.length > 0 is load-bearing: an empty run must never read complete.
   */
  private async recomputeRunStatus(runId: number, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    const [lines, run] = await Promise.all([
      tx.payroll_run_lines.findMany({ where: { payroll_run_id: runId }, select: { finalized_at: true } }),
      tx.payroll_runs.findUnique({ where: { id: runId }, select: { status: true, finalized_at: true } }),
    ]);
    if (!run) return;
    const allDone = lines.length > 0 && lines.every((l) => l.finalized_at !== null);
    const nextStatus = allDone ? PayrollRunStatus.FINALIZED : PayrollRunStatus.DRAFT;
    if (nextStatus === run.status && (nextStatus === PayrollRunStatus.DRAFT ? true : !!run.finalized_at)) return;
    await tx.payroll_runs.update({
      where: { id: runId },
      data: { status: nextStatus, finalized_at: allDone ? (run.finalized_at ?? new Date()) : null },
    });
  }

  // Flags are stored on the run, not the line (their identity must survive a
  // DRAFT regenerate, which replaces every line's id) — attach them onto
  // their line by employee_id for the API response. Also stamps the derived
  // per-line status so the frontend doesn't re-derive this tri-state itself.
  private attachDerivedFieldsToLines<
    T extends {
      payroll_run_lines: { employee_id: number; finalized_at: Date | null; disbursed_at: Date | null }[];
      payroll_flags: unknown[];
    },
  >(run: T) {
    const flagsByEmployee = new Map<number, unknown[]>();
    for (const flag of run.payroll_flags as { employee_id: number }[]) {
      const bucket = flagsByEmployee.get(flag.employee_id);
      if (bucket) bucket.push(flag);
      else flagsByEmployee.set(flag.employee_id, [flag]);
    }
    return {
      ...run,
      payroll_run_lines: run.payroll_run_lines.map((line) => ({
        ...line,
        line_status: this.deriveLineStatus(line),
        payroll_flags: flagsByEmployee.get(line.employee_id) ?? [],
      })),
    };
  }

  /**
   * "Finalize All": finalizes every still-pending, eligible employee line on
   * the run in one call — the bulk counterpart to finalizeLine. Unlike the
   * old whole-run finalize, ineligibility is per-employee: a line with
   * unresolved days or a pending flag is skipped (with a reason) rather than
   * blocking every other employee. Only throws if there's nothing pending at
   * all left to finalize.
   */
  async finalizeRun(id: number, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({
      where: { id },
      include: {
        payroll_run_lines: {
          include: { employee_profiles: { select: { user_id: true } } },
        },
      },
    });
    if (!run) throw new NotFoundException(`Payroll run ${id} not found`);
    this.assertCampusAccess(user, run.campus_id);

    const pendingLines = run.payroll_run_lines.filter((l) => !l.finalized_at);
    if (pendingLines.length === 0) {
      throw new BadRequestException('This payroll run is already fully finalized.');
    }

    const pendingFlags = await this.prisma.payroll_flags.findMany({
      where: { payroll_run_id: id, status: PayrollFlagStatus.PENDING },
      select: { employee_id: true },
    });
    const pendingFlagCounts = new Map<number, number>();
    for (const flag of pendingFlags) {
      pendingFlagCounts.set(flag.employee_id, (pendingFlagCounts.get(flag.employee_id) ?? 0) + 1);
    }

    const finalizedNow: typeof pendingLines = [];
    const skipped: { employee_id: number; reason: string }[] = [];
    const finalizedAt = new Date();

    for (const line of pendingLines) {
      if (line.unresolved_days > 0) {
        skipped.push({ employee_id: line.employee_id, reason: `${line.unresolved_days} unresolved attendance day(s)` });
        continue;
      }
      const flagCount = pendingFlagCounts.get(line.employee_id) ?? 0;
      if (flagCount > 0) {
        skipped.push({ employee_id: line.employee_id, reason: `${flagCount} pending flag(s) need a decision` });
        continue;
      }
      await this.prisma.$transaction(async (tx) => {
        await this.applyDiscretionaryDeductionsToLine(id, line.employee_id, tx);
        await tx.payroll_run_lines.update({
          where: { id: line.id },
          data: { finalized_at: finalizedAt, finalized_by: user.sub },
        });
        await this.commitDiscretionaryDeductions(line.id, user.sub, tx);
      });
      finalizedNow.push(line);
    }

    await this.recomputeRunStatus(id);

    const campus = await this.prisma.campuses.findUnique({ where: { id: run.campus_id }, select: { campus_name: true } });
    const periodLabel = `${run.period_start.toISOString().slice(0, 10)} to ${run.period_end.toISOString().slice(0, 10)}`;

    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(id),
      action: 'FINALIZE_ALL',
      changed_by: auditActorLabel(user),
      note: `${campus?.campus_name ?? `Campus #${run.campus_id}`}, period ${periodLabel}: ${finalizedNow.length} employee line(s) finalized, ${skipped.length} skipped.`,
    });

    // Test runs are throwaway/repeatable — no reason to page a test employee
    // every time one gets finalized during testing.
    if (!run.is_test) {
      const title = 'Payroll finalized';
      const body = `Your payroll for ${periodLabel} has been finalized.`;
      for (const line of finalizedNow) {
        const userId = line.employee_profiles.user_id;
        if (!userId) continue;
        void this.employeeNoticeBoard
          .createPayrollNotice(line.employee_id, userId, title, body, id)
          .catch((err) => this.logger.error(`Failed to send payroll-finalized notice for employee ${line.employee_id}`, err));
      }
    }

    const updatedRun = await this.getRun(id, user);
    return { ...updatedRun, finalize_summary: { finalized: finalizedNow.length, skipped } };
  }

  async deleteRun(id: number, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`Payroll run ${id} not found`);
    this.assertCampusAccess(user, run.campus_id);
    if (!run.is_test) {
      // payroll_runs.status can no longer be trusted alone here — it only
      // reads FINALIZED once every line is done, but a single finalized/
      // settled line (with colleagues still pending) would otherwise leave
      // this check silently bypassed and cascade-delete real payroll history.
      const finalizedLineCount = await this.prisma.payroll_run_lines.count({
        where: { payroll_run_id: id, finalized_at: { not: null } },
      });
      if (finalizedLineCount > 0) {
        throw new BadRequestException(
          `This payroll run has ${finalizedLineCount} finalized employee line(s) and cannot be deleted.`,
        );
      }
    }
    await this.prisma.payroll_runs.delete({ where: { id } });

    const campus = await this.prisma.campuses.findUnique({ where: { id: run.campus_id }, select: { campus_name: true } });
    const periodLabel = `${run.period_start.toISOString().slice(0, 10)} to ${run.period_end.toISOString().slice(0, 10)}`;
    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: auditActorLabel(user),
      note: `Deleted payroll run for ${campus?.campus_name ?? `Campus #${run.campus_id}`}, period ${periodLabel}, status was ${run.status}.`,
    });

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
        // cash_bonus_amount is deliberately never selected here — it must
        // never reach an employee, only ever the admin panel. See
        // SettlePayrollLineDto#cash_bonus_amount.
        payroll_settlements: {
          select: {
            overtime_rate_type: true,
            overtime_rate_amount: true,
            overtime_minutes: true,
            overtime_reward_amount: true,
            net_paid: true,
            payslip_pdf_url: true,
            settled_at: true,
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
      line_status: this.deriveLineStatus(line),
      disbursed_at: line.disbursed_at?.toISOString() ?? null,
      disbursement_notes: line.disbursement_notes,
      monthly_pay: Number(line.monthly_pay),
      total_deductions: Number(line.total_deductions),
      eobi_deduction: Number(line.eobi_deduction),
      income_tax_deduction: Number(line.income_tax_deduction),
      security_deposit_deduction: Number(line.security_deposit_deduction),
      loan_deduction: Number(line.loan_deduction),
      net_pay: Number(line.net_pay),
      overtime_days: line.overtime_days,
      settlement: line.payroll_settlements
        ? {
            overtime_rate_type: line.payroll_settlements.overtime_rate_type,
            overtime_rate_amount: line.payroll_settlements.overtime_rate_amount != null ? Number(line.payroll_settlements.overtime_rate_amount) : null,
            overtime_minutes: line.payroll_settlements.overtime_minutes,
            overtime_reward_amount: Number(line.payroll_settlements.overtime_reward_amount),
            net_paid: Number(line.payroll_settlements.net_paid),
            payslip_pdf_url: line.payroll_settlements.payslip_pdf_url,
            settled_at: line.payroll_settlements.settled_at.toISOString(),
          }
        : null,
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
        // cash_bonus_amount is deliberately never selected here — internal-only, see listMyPayrollLines above.
        payroll_settlements: {
          select: {
            overtime_rate_type: true,
            overtime_rate_amount: true,
            overtime_minutes: true,
            overtime_reward_amount: true,
            net_paid: true,
            payslip_pdf_url: true,
            settled_at: true,
          },
        },
      },
    });
    if (!line) throw new NotFoundException('Payroll line not found for this period');

    // eobi_employer_cost/sessi_employer_cost are deliberately excluded from
    // the spread below — internal-only, must never reach an employee. See
    // cash_bonus_amount handling above for the same pattern.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { payroll_settlements, eobi_employer_cost, sessi_employer_cost, ...lineFields } = line;

    return {
      ...lineFields,
      monthly_pay: Number(line.monthly_pay),
      daily_rate: Number(line.daily_rate),
      per_minute_rate: Number(line.per_minute_rate),
      absence_deduction: Number(line.absence_deduction),
      half_day_deduction: Number(line.half_day_deduction),
      late_deduction: Number(line.late_deduction),
      break_deduction: Number(line.break_deduction),
      sandwich_deduction: Number(line.sandwich_deduction),
      consecutive_late_deduction: Number(line.consecutive_late_deduction),
      eobi_deduction: Number(line.eobi_deduction),
      income_tax_deduction: Number(line.income_tax_deduction),
      security_deposit_deduction: Number(line.security_deposit_deduction),
      loan_deduction: Number(line.loan_deduction),
      total_deductions: Number(line.total_deductions),
      net_pay: Number(line.net_pay),
      overtime_days: line.overtime_days,
      disbursed_at: line.disbursed_at?.toISOString() ?? null,
      line_status: this.deriveLineStatus(line),
      run: line.payroll_runs,
      settlement: payroll_settlements
        ? {
            overtime_rate_type: payroll_settlements.overtime_rate_type,
            overtime_rate_amount: payroll_settlements.overtime_rate_amount != null ? Number(payroll_settlements.overtime_rate_amount) : null,
            overtime_minutes: payroll_settlements.overtime_minutes,
            overtime_reward_amount: Number(payroll_settlements.overtime_reward_amount),
            net_paid: Number(payroll_settlements.net_paid),
            payslip_pdf_url: payroll_settlements.payslip_pdf_url,
            settled_at: payroll_settlements.settled_at.toISOString(),
          }
        : null,
    };
  }

  async disburseLine(runId: number, employeeId: number, dto: DisbursePayrollLineDto, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);

    const existingLine = await this.prisma.payroll_run_lines.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
      select: { finalized_at: true },
    });
    if (!existingLine) throw new NotFoundException(`Payroll line for employee ${employeeId} not found on run ${runId}`);
    if (!existingLine.finalized_at) {
      throw new BadRequestException("Disbursement is only allowed once this employee's payroll line has been finalized");
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
      include: { employee_profiles: { select: { full_name: true, employee_code: true } } },
    });

    const employeeLabel = line.employee_profiles.full_name
      ? `${line.employee_profiles.full_name}${line.employee_profiles.employee_code ? ` (${line.employee_profiles.employee_code})` : ''}`
      : line.employee_profiles.employee_code ?? `Employee #${employeeId}`;

    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(runId),
      action: 'DISBURSED',
      field: 'employee_id',
      new_value: String(employeeId),
      changed_by: auditActorLabel(user),
      note: [`Disbursement for ${employeeLabel}.`, dto.notes].filter(Boolean).join(' '),
    });

    return { ...line, line_status: this.deriveLineStatus(line) };
  }

  async disburseAll(runId: number, dto: DisbursePayrollLineDto, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);

    const disbursedAt = dto.disbursed_at ? new Date(dto.disbursed_at) : new Date();
    if (Number.isNaN(disbursedAt.getTime())) {
      throw new BadRequestException('Invalid disbursed_at');
    }

    const { count } = await this.prisma.payroll_run_lines.updateMany({
      where: { payroll_run_id: runId, disbursed_at: null, finalized_at: { not: null } },
      data: {
        disbursed_at: disbursedAt,
        disbursed_by: user.sub,
        disbursement_notes: dto.notes ?? null,
      },
    });

    const periodLabel = `${run.period_start.toISOString().slice(0, 10)} to ${run.period_end.toISOString().slice(0, 10)}`;
    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(runId),
      action: 'DISBURSED_ALL',
      changed_by: auditActorLabel(user),
      note: `Disbursed ${count} line(s) for period ${periodLabel}.${dto.notes ? ` Notes: ${dto.notes}` : ''}`,
    });

    return this.getRun(runId, user);
  }

  /** overtime_minutes/overtime_days are always the line's own persisted snapshot — never recomputed live. */
  private computeOvertimeReward(
    overtime: SettlePayrollLineDto['overtime'],
    overtimeMinutes: number,
    overtimeDays: number,
  ): Prisma.Decimal {
    if (!overtime) return new Prisma.Decimal(0);
    const rate = new Prisma.Decimal(overtime.rate_amount);
    if (overtime.rate_type === OvertimeRateType.PER_MINUTE) {
      return rate.times(overtimeMinutes).toDecimalPlaces(2);
    }
    if (overtime.rate_type === OvertimeRateType.PER_HOUR) {
      return rate.times(overtimeMinutes).dividedBy(60).toDecimalPlaces(2);
    }
    // PER_DAY rewards the number of distinct days overtime was worked, not a
    // fractional proration of total overtime minutes into a "day".
    return rate.times(overtimeDays).toDecimalPlaces(2);
  }

  /**
   * Replaces the plain "mark disbursed" button with a full settlement:
   * optionally rewards overtime (computed off the line's own persisted
   * snapshot, never recomputed live), optionally records an off-the-books
   * cash bonus (kept in payroll_settlements, never returned to
   * self-service), and always produces a payslip PDF. Still stamps
   * disbursed_at/disbursed_by on the line — that marker is unchanged, this
   * is additive.
   */
  async settleLine(runId: number, employeeId: number, dto: SettlePayrollLineDto, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({
      where: { id: runId },
      include: { campuses: { select: { campus_name: true } } },
    });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);

    const line = await this.prisma.payroll_run_lines.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
      include: { employee_profiles: { select: { full_name: true, employee_code: true, job_title: true, user_id: true } } },
    });
    if (!line) throw new NotFoundException(`Payroll line for employee ${employeeId} not found on run ${runId}`);
    if (!line.finalized_at) {
      throw new BadRequestException("Settlement is only allowed once this employee's payroll line has been finalized");
    }

    const settledAt = dto.disbursed_at ? new Date(dto.disbursed_at) : new Date();
    if (Number.isNaN(settledAt.getTime())) {
      throw new BadRequestException('Invalid disbursed_at');
    }

    const overtimeRewardAmount = this.computeOvertimeReward(dto.overtime, line.total_overtime_minutes, line.overtime_days);
    const cashBonusAmount = new Prisma.Decimal(dto.cash_bonus_amount ?? 0).toDecimalPlaces(2);
    const netPaid = new Prisma.Decimal(line.net_pay).plus(overtimeRewardAmount).toDecimalPlaces(2);

    const settlementData = {
      overtime_rate_type: dto.overtime?.rate_type ?? null,
      overtime_rate_amount: dto.overtime ? new Prisma.Decimal(dto.overtime.rate_amount) : null,
      overtime_minutes: line.total_overtime_minutes,
      overtime_reward_amount: overtimeRewardAmount,
      cash_bonus_amount: cashBonusAmount,
      net_paid: netPaid,
      settled_at: settledAt,
      settled_by: user.sub,
      settlement_notes: dto.notes ?? null,
    };

    const [updatedLine] = await this.prisma.$transaction([
      this.prisma.payroll_run_lines.update({
        where: { id: line.id },
        data: {
          disbursed_at: settledAt,
          disbursed_by: user.sub,
          disbursement_notes: dto.notes ?? null,
        },
        include: { employee_profiles: { select: { full_name: true, employee_code: true } } },
      }),
      this.prisma.payroll_settlements.upsert({
        where: { payroll_run_line_id: line.id },
        create: { payroll_run_line_id: line.id, ...settlementData },
        update: settlementData,
      }),
    ]);

    const employeeLabel = line.employee_profiles.full_name
      ? `${line.employee_profiles.full_name}${line.employee_profiles.employee_code ? ` (${line.employee_profiles.employee_code})` : ''}`
      : line.employee_profiles.employee_code ?? `Employee #${employeeId}`;

    // Payslip generation/upload happens after the settlement numbers are
    // committed — a failure here shouldn't be able to roll back a
    // successful settlement, it just leaves payslip_pdf_url null and can be
    // retried by settling again.
    let finalSettlement = await this.prisma.payroll_settlements.findUnique({ where: { payroll_run_line_id: line.id } });
    try {
      const buffer = await this.payslipPdf.generatePayslipPdf({
        employee: {
          fullName: line.employee_profiles.full_name ?? `Employee #${employeeId}`,
          employeeCode: line.employee_profiles.employee_code,
          jobTitle: line.employee_profiles.job_title,
          campusName: run.campuses?.campus_name ?? `Campus #${run.campus_id}`,
        },
        period: {
          start: run.period_start.toISOString().slice(0, 10),
          end: run.period_end.toISOString().slice(0, 10),
        },
        attendance: {
          scheduledWorkingDays: line.scheduled_working_days,
          presentDays: line.present_days,
          lateDays: line.late_days,
          halfDays: line.half_days,
          absentDays: line.absent_days,
          excusedDays: line.excused_days,
          unpaidLeaveDays: line.unpaid_leave_days,
          totalBreakMinutes: line.total_break_minutes,
          totalLateMinutes: line.total_late_minutes,
        },
        pay: {
          monthlyPay: Number(line.monthly_pay),
          dailyRate: Number(line.daily_rate),
          absenceDeduction: Number(line.absence_deduction),
          halfDayDeduction: Number(line.half_day_deduction),
          lateDeduction: Number(line.late_deduction),
          breakDeduction: Number(line.break_deduction),
          sandwichDeduction: Number(line.sandwich_deduction),
          consecutiveLateDeduction: Number(line.consecutive_late_deduction),
          eobiDeduction: Number(line.eobi_deduction),
          incomeTaxDeduction: Number(line.income_tax_deduction),
          securityDepositDeduction: Number(line.security_deposit_deduction),
          loanDeduction: Number(line.loan_deduction),
          totalDeductions: Number(line.total_deductions),
          netPay: Number(line.net_pay),
        },
        overtime: dto.overtime
          ? {
              rateType: dto.overtime.rate_type,
              rateAmount: dto.overtime.rate_amount,
              overtimeMinutes: line.total_overtime_minutes,
              overtimeDays: line.overtime_days,
              rewardAmount: Number(overtimeRewardAmount),
            }
          : undefined,
        netPaid: Number(netPaid),
        settledAt: settledAt.toLocaleDateString(),
        generatedByName: user.username,
      });

      const payslipUrl = await this.storage.upload(`payroll/payslips/${runId}/${employeeId}.pdf`, buffer, 'application/pdf');
      finalSettlement = await this.prisma.payroll_settlements.update({
        where: { payroll_run_line_id: line.id },
        data: { payslip_pdf_url: payslipUrl },
      });
    } catch (error) {
      this.logger.error(`Failed to generate/upload payslip for run ${runId}, employee ${employeeId}`, error as Error);
    }

    void this.auditLogs.log({
      entity_type: 'PAYROLL_RUN',
      entity_id: String(runId),
      action: 'SETTLED',
      field: 'employee_id',
      new_value: String(employeeId),
      changed_by: auditActorLabel(user),
      note: [
        `Settlement for ${employeeLabel}.`,
        overtimeRewardAmount.greaterThan(0) ? `Overtime reward of ${overtimeRewardAmount.toString()} added.` : null,
        cashBonusAmount.greaterThan(0) ? 'Cash bonus recorded (internal only).' : null,
        dto.notes,
      ]
        .filter(Boolean)
        .join(' '),
    });

    // Same rationale as finalizeRun: test runs are repeated constantly
    // during testing and shouldn't page the shared test employees each time.
    if (!run.is_test && line.employee_profiles.user_id) {
      const periodLabel = `${run.period_start.toISOString().slice(0, 10)} to ${run.period_end.toISOString().slice(0, 10)}`;
      void this.employeeNoticeBoard
        .createPayrollNotice(
          employeeId,
          line.employee_profiles.user_id,
          'Salary settled',
          `Your salary for ${periodLabel} has been settled. Please check your bank account.`,
          runId,
        )
        .catch((err) => this.logger.error(`Failed to send payroll-settled notice for employee ${employeeId}`, err));
    }

    return { ...updatedLine, line_status: this.deriveLineStatus(updatedLine), payroll_settlements: finalSettlement };
  }

  /** Returns the persisted payslip URL for an already-settled employee line. */
  async getPayslip(runId: number, employeeId: number, user: IJwtStaffPayload) {
    const run = await this.prisma.payroll_runs.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);
    this.assertCampusAccess(user, run.campus_id);

    const line = await this.prisma.payroll_run_lines.findUnique({
      where: { payroll_run_id_employee_id: { payroll_run_id: runId, employee_id: employeeId } },
      include: { payroll_settlements: true },
    });
    if (!line?.payroll_settlements?.payslip_pdf_url) {
      throw new NotFoundException('This employee has not been settled for this payroll run yet, so there is no payslip.');
    }
    return { pdf_url: line.payroll_settlements.payslip_pdf_url };
  }
}
