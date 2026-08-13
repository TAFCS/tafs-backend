import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma, RollRecordStatus, AttendanceSource } from '@prisma/client';
import { CalendarDayResolverService } from '../hr/calendar/calendar-day-resolver.service';
import { resolveStudentAttendanceStatus, getTodayKeyKarachi } from '../attendance/student-attendance-status.util';
import { AttendancePolicyResolverService } from '../attendance/attendance-policy-resolver.service';
import { TeachingGroupsService } from '../timetables/teaching-groups.service';

@Injectable()
export class AppPortalService {
  constructor(
    private prisma: PrismaService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly policyResolver: AttendancePolicyResolverService,
    private readonly teachingGroups: TeachingGroupsService,
  ) {}

  async getStudentLedger(studentCc: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc: studentCc },
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        photograph_url: true,
        academic_year: true,
        campuses: { select: { campus_name: true } },
        classes: { select: { description: true } },
        sections: { select: { description: true } },
        houses: { select: { house_name: true, house_color: true } },
        status: true,
        graduated_from_class_id: true,
        graduated_at: true,
        graduated_from_class: { select: { description: true } },
        dob: true,
        gender: true,
        student_guardians: {
          include: {
            guardians: {
              select: {
                full_name: true,
                primary_phone: true,
              },
            },
          },
        },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with CC ${studentCc} not found`);
    }

    // Fetch all relevant fees for this student
    const allFees = await this.prisma.student_fees.findMany({
      where: {
        student_id: studentCc,
      },
      include: {
        fee_types: true,
      },
      orderBy: [
        { academic_year: 'desc' },
        { target_month: 'desc' },
      ],
    });

    const outstandingHeads = allFees.filter(fee => {
      const isIssued = fee.status === 'ISSUED';
      const isPartial = fee.status === 'PARTIALLY_PAID';
      const notPaid = fee.status !== 'PAID';
      
      const amount = new Prisma.Decimal(fee.amount ?? 0);
      const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
      const payable = amount.sub(paid);

      return notPaid && (isIssued || isPartial) && payable.gt(0);
    });

    const paidHeads = allFees.filter(fee => fee.status === 'PAID');

    // Grouping helper
    const groupByMonth = (fees: any[]) => {
      const groups = new Map<string, any>();

      for (const fee of fees) {
        const key = `${fee.academic_year}-${fee.target_month}`;
        if (!groups.has(key)) {
          groups.set(key, {
            target_month: fee.target_month,
            academic_year: fee.academic_year,
            monthLabel: this.getMonthLabel(fee.target_month),
            heads: [],
            group_payable: 0,
          });
        }

        const group = groups.get(key);
        const amount = new Prisma.Decimal(fee.amount ?? 0);
        const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
        const payable = amount.sub(paid);

        group.heads.push({
          id: fee.id,
          description: `${fee.description_prefix ? fee.description_prefix + ' — ' : ''}${fee.fee_types.description}`,
          amount: amount.toNumber(),
          amount_paid: paid.toNumber(),
          payable: payable.toNumber(),
          status: fee.status,
          fee_date: fee.fee_date,
          is_issued: fee.status !== 'NOT_ISSUED',
        });

        group.group_payable += payable.toNumber();
      }

      return Array.from(groups.values());
    };

    const outstandingGroups = groupByMonth(outstandingHeads);
    const paidGroups = groupByMonth(paidHeads);

    const totalOutstanding = outstandingHeads.reduce((sum, fee) => {
      const amount = new Prisma.Decimal(fee.amount ?? 0);
      const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
      return sum.add(amount.sub(paid));
    }, new Prisma.Decimal(0));

    const totalPaidThisYear = paidHeads
      .filter(fee => fee.academic_year === student.academic_year)
      .reduce((sum, fee) => sum.add(new Prisma.Decimal(fee.amount_paid ?? 0)), new Prisma.Decimal(0));

    return {
      student: {
        cc: student.cc,
        full_name: student.full_name,
        gr_number: student.gr_number,
        campus: student.campuses?.campus_name,
        class: student.classes?.description,
        section: student.sections?.description,
        house: student.houses?.house_name,
        house_color: student.houses?.house_color,
        photograph_url: student.photograph_url,
        dob: student.dob,
        gender: student.gender,
        enrollment_status: student.status,
        graduated_from_class: student.graduated_from_class?.description ?? null,
        graduated_at: student.graduated_at,
        guardians: student.student_guardians.map(sg => ({
          name: sg.guardians.full_name,
          relationship: sg.relationship,
          phone: sg.guardians.primary_phone,
        })),
      },
      outstanding: outstandingGroups,
      paid: paidGroups,
      summary: {
        total_outstanding: totalOutstanding.toNumber(),
        total_paid_this_year: totalPaidThisYear.toNumber(),
      },
    };
  }

  private getMonthLabel(month: number): string {
    const labels = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return labels[month - 1] || 'Unknown';
  }

  async getStudentAttendanceHistory(studentCc: number, monthStr: string) {
    if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
      throw new Error('Invalid month format. Expected YYYY-MM');
    }

    const [year, month] = monthStr.split('-').map(Number);
    const dateFrom = new Date(Date.UTC(year, month - 1, 1));
    const dateTo = new Date(Date.UTC(year, month, 0)); // last day of month

    const student = await this.prisma.students.findUnique({
      where: { cc: studentCc },
      select: { campus_id: true, class_id: true, section_id: true },
    });

    if (await this.isRollCallClass(student?.class_id ?? null)) {
      return this.getStudentRollCallHistory(studentCc, student!, dateFrom, dateTo, monthStr);
    }

    const [schedules, policySets] = student?.campus_id != null
      ? await Promise.all([
          this.prisma.class_check_in_schedules.findMany({
            where: {
              class_id: student.class_id ?? undefined,
              campus_id: student.campus_id,
              effective_from: { lte: dateTo },
            },
            orderBy: { effective_from: 'desc' },
          }),
          this.prisma.hr_policy_sets.findMany({
            where: {
              campus_id: student.campus_id,
              effective_from: { lte: dateTo },
            },
            orderBy: { effective_from: 'desc' },
            include: { hr_policy_rules: true },
          }),
        ])
      : [[], []];

    const [scans, records] = await Promise.all([
      this.prisma.zk_attendance_scans.findMany({
        where: {
          student_cc: studentCc,
          person_type: 'STUDENT',
          is_duplicate: false,
          attendance_date: { gte: dateFrom, lte: dateTo },
        },
        orderBy: { scan_time: 'asc' },
      }),
      this.prisma.attendance_student_daily.findMany({
        where: { student_cc: studentCc, date: { gte: dateFrom, lte: dateTo } },
      }),
    ]);

    const calendarMap =
      student?.campus_id != null
        ? await this.calendarResolver.loadStudentCalendarMap(
            student.campus_id,
            student.class_id,
            student.section_id,
            dateFrom,
            dateTo,
          )
        : new Map();

    const scansByDate = new Map<string, any[]>();
    for (const scan of scans) {
      const key = scan.attendance_date.toISOString().slice(0, 10);
      const bucket = scansByDate.get(key);
      if (bucket) bucket.push(scan);
      else scansByDate.set(key, [scan]);
    }
    const recordMap = new Map(records.map((r) => [r.date.toISOString().slice(0, 10), r]));

    const todayKey = getTodayKeyKarachi();
    const days: any[] = [];
    for (let d = new Date(dateFrom); d <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      const record = recordMap.get(key) ?? null;
      const dayScans = scansByDate.get(key) ?? [];
      const resolved = calendarMap.get(key) ?? {
        isWorkingDay: d.getUTCDay() !== 0 && d.getUTCDay() !== 6,
        dayType: d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 'WEEKEND' : null,
        description: null,
        source: 'DEFAULT',
      };

      const sessions: any[] = [];
      for (let i = 0; i + 1 < dayScans.length; i += 2) {
        sessions.push({
          clock_in: dayScans[i].scan_time,
          clock_out: dayScans[i + 1].scan_time,
        });
      }
      if (dayScans.length % 2 !== 0) {
        sessions.push({
          clock_in: dayScans[dayScans.length - 1].scan_time,
          clock_out: null,
        });
      }

      const { holiday_type, holiday_description } = this.calendarResolver.toHolidayDisplay(resolved);

      // Resolve check-in policy in memory
      const { expectedCheckIn, graceMinutes } = this.policyResolver.resolveStudentCheckInPolicyFromCache(
        student?.class_id ?? null,
        d,
        schedules,
        policySets,
      );

      const hasCheckIn = !!record?.check_in_at || dayScans.length > 0;
      const status = resolveStudentAttendanceStatus({
        dateKey: key,
        todayKey,
        isWorkingDay: resolved.isWorkingDay,
        recordStatus: record?.status ?? null,
        recordSource: record?.source ?? null,
        hasCheckIn,
        checkInAt: record?.check_in_at ?? dayScans[0]?.scan_time ?? null,
        expectedCheckIn,
        graceMinutes,
      });

      days.push({
        date: key,
        status,
        sessions,
        holiday_type: resolved.isWorkingDay
          ? null
          : holiday_type ?? (status === RollRecordStatus.EXCUSED ? resolved.dayType ?? 'HOLIDAY' : null),
        holiday_description: resolved.isWorkingDay ? null : holiday_description ?? resolved.description,
      });
    }

    return {
      student_cc: studentCc,
      month: monthStr,
      mode: 'BIOMETRIC_DAILY',
      days,
    };
  }

  /** Fallback IDs used only when no class_attendance_modes rows exist yet
   * (mirrors roll-sessions.service.ts's DEFAULT_ROLL_CALL_CLASS_IDS). */
  private async isRollCallClass(classId: number | null): Promise<boolean> {
    if (classId == null) return false;
    const mode = await this.prisma.class_attendance_modes.findUnique({
      where: { class_id: classId },
    });
    if (mode) return mode.mode === 'ROLL_CALL_SESSION';
    return [20, 21].includes(classId);
  }

  /** Attendance history for AS/A2-style roll-call classes: each day's
   * scheduled periods (from the student's teaching-group enrollments)
   * annotated with that day's actual roll-call status, if taken. */
  private async getStudentRollCallHistory(
    studentCc: number,
    student: { campus_id: number | null; class_id: number | null; section_id: number | null },
    dateFrom: Date,
    dateTo: Date,
    monthStr: string,
  ) {
    const weekly = await this.teachingGroups.getStudentWeeklySlots(studentCc);
    const slotsByDay = new Map<number, typeof weekly.blocks>();
    for (const slot of weekly.blocks) {
      const list = slotsByDay.get(slot.day_of_week) ?? [];
      list.push(slot);
      slotsByDay.set(slot.day_of_week, list);
    }

    const groupIds = [...new Set(weekly.blocks.map((b) => b.teaching_group_id))].filter(
      (id): id is number => id != null,
    );
    const sessions = await this.prisma.attendance_roll_sessions.findMany({
      where: {
        teaching_group_id: { in: groupIds },
        session_date: { gte: dateFrom, lte: dateTo },
      },
      include: {
        attendance_roll_records: { where: { student_cc: studentCc } },
      },
    });
    const sessionByKey = new Map(
      sessions.map((s) => [
        `${s.session_date.toISOString().slice(0, 10)}|${s.teaching_group_id}|${s.period}`,
        s,
      ]),
    );

    const calendarMap =
      student.campus_id != null
        ? await this.calendarResolver.loadStudentCalendarMap(
            student.campus_id,
            student.class_id,
            student.section_id,
            dateFrom,
            dateTo,
          )
        : new Map();

    const days: any[] = [];
    for (let d = new Date(dateFrom); d <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      const resolved = calendarMap.get(key) ?? {
        isWorkingDay: d.getUTCDay() !== 0 && d.getUTCDay() !== 6,
        dayType: d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 'WEEKEND' : null,
        description: null,
        source: 'DEFAULT',
      };
      const { holiday_type, holiday_description } = this.calendarResolver.toHolidayDisplay(resolved);

      const daySlots = resolved.isWorkingDay ? slotsByDay.get(d.getUTCDay()) ?? [] : [];
      const periods = daySlots.map((slot) => {
        const session = sessionByKey.get(`${key}|${slot.teaching_group_id}|${slot.block_number}`);
        const record = session?.attendance_roll_records?.[0];
        const status = session?.status === 'SKIPPED' ? 'SKIPPED' : record?.status ?? 'NOT_MARKED';
        return {
          block_number: slot.block_number,
          start_time: slot.start_time,
          end_time: slot.end_time,
          label: slot.label,
          subject: slot.subject,
          teacher: slot.teacher,
          room: slot.room,
          status,
          skip_reason: session?.status === 'SKIPPED' ? session.skip_reason : null,
        };
      });

      // Day-level rollup so the existing calendar month-grid (built around
      // one status per day) keeps working unchanged.
      let status: string | null = null;
      if (resolved.isWorkingDay && periods.length > 0) {
        if (periods.some((p) => p.status === 'ABSENT')) status = 'ABSENT';
        else if (periods.some((p) => p.status === 'LATE')) status = 'LATE';
        else if (periods.every((p) => p.status === 'PRESENT')) status = 'PRESENT';
        else if (periods.every((p) => p.status === 'NOT_MARKED')) status = null;
        else status = 'EXCUSED';
      }

      days.push({
        date: key,
        status,
        periods,
        holiday_type: resolved.isWorkingDay ? null : holiday_type,
        holiday_description: resolved.isWorkingDay ? null : holiday_description ?? resolved.description,
      });
    }

    return {
      student_cc: studentCc,
      month: monthStr,
      mode: 'ROLL_CALL_SESSION',
      days,
    };
  }
}
