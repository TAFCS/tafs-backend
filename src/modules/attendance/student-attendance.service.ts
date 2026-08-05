import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RollRecordStatus, zk_attendance_scans, AttendanceSource } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { assertClassInScope } from '../../common/staff-scope';
import { CalendarDayResolverService } from '../hr/calendar/calendar-day-resolver.service';
import { HolidayAttendanceSyncService } from '../hr/calendar/holiday-attendance-sync.service';
import { resolveStudentAttendanceStatus, getTodayKeyKarachi } from './student-attendance-status.util';
import {
  GetStudentAttendanceQueryDto,
  BulkManualStudentAttendanceDto,
  GetStudentTimelineQueryDto,
  ManualStudentScanDto,
  ResolveStudentAttendanceDto,
} from './dto/student-attendance.dto';
import { AttendancePolicyResolverService } from './attendance-policy-resolver.service';
import { MANUAL_DEVICE_SN, ZkAttendanceProcessorService } from './zk-attendance-processor.service';

@Injectable()
export class StudentAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly holidaySync: HolidayAttendanceSyncService,
    private readonly policyResolver: AttendancePolicyResolverService,
    private readonly auditLogs: AuditLogsService,
    private readonly processor: ZkAttendanceProcessorService,
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

  private async getStudentsInScope(
    campusId: number,
    classId: number | undefined,
    sectionId: number | undefined,
    user: IJwtStaffPayload,
  ) {
    if (classId) {
      assertClassInScope(user, classId);
    }
    const allowed = user.allowedClassIds ?? [];

    const where: Prisma.studentsWhereInput = {
      campus_id: campusId,
      status: 'ENROLLED',
      deleted_at: null,
      ...(classId
        ? { class_id: classId }
        : allowed.length > 0
          ? { class_id: { in: allowed } }
          : {}),
      ...(sectionId ? { section_id: sectionId } : {}),
    };

    return this.prisma.students.findMany({
      where,
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        photograph_url: true,
        class_id: true,
        section_id: true,
        classes: { select: { id: true, description: true, class_code: true } },
        sections: { select: { id: true, description: true } },
      },
      orderBy: [{ class_id: 'asc' }, { section_id: 'asc' }, { full_name: 'asc' }],
    });
  }

  private async getCountsForDate(
    campusId: number,
    classId: number | undefined,
    sectionId: number | undefined,
    date: Date,
    user: IJwtStaffPayload,
  ) {
    const students = await this.getStudentsInScope(campusId, classId, sectionId, user);
    if (students.length === 0) {
      return { present: 0, late: 0, excused: 0, absent: 0, noClockIn: 0, noClockOut: 0 };
    }

    const records = await this.prisma.attendance_student_daily.findMany({
      where: { date, student_cc: { in: students.map((s) => s.cc) } },
    });

    const present = records.filter((r) => r.status === RollRecordStatus.PRESENT || r.status === RollRecordStatus.LATE).length;
    const late = records.filter((r) => r.status === RollRecordStatus.LATE).length;
    const excused = records.filter((r) => r.status === RollRecordStatus.EXCUSED).length;
    const absent = records.filter((r) => r.status === RollRecordStatus.ABSENT).length;
    const noClockIn = students.length - records.length;

    return { present, late, excused, absent, noClockIn, noClockOut: records.filter((r) => r.check_in_at && !r.check_out_at).length };
  }

  async getSummary(query: GetStudentAttendanceQueryDto, user: IJwtStaffPayload) {
    const date = this.parseDate(query.date);
    const campusId = query.campus_id ?? user.campusId ?? undefined;
    if (!campusId) throw new BadRequestException('campus_id is required');
    this.assertCampusAccess(user, campusId);

    const previousDate = new Date(date);
    previousDate.setUTCDate(previousDate.getUTCDate() - 1);

    const [today, yesterday] = await Promise.all([
      this.getCountsForDate(campusId, query.class_id, query.section_id, date, user),
      this.getCountsForDate(campusId, query.class_id, query.section_id, previousDate, user),
    ]);

    const card = (key: keyof typeof today) => ({ count: today[key], delta: today[key] - yesterday[key] });

    return {
      present_summary: {
        present: card('present'),
        late: card('late'),
      },
      not_present_summary: {
        absent: card('absent'),
        excused: card('excused'),
        no_clock_in: card('noClockIn'),
        no_clock_out: card('noClockOut'),
      },
    };
  }

  async getDashboard(query: GetStudentAttendanceQueryDto, user: IJwtStaffPayload) {
    const date = this.parseDate(query.date);
    const campusId = query.campus_id ?? user.campusId ?? undefined;
    if (!campusId) throw new BadRequestException('campus_id is required');
    this.assertCampusAccess(user, campusId);

    await this.holidaySync.syncCampusForDate(campusId, date);

    const students = await this.getStudentsInScope(campusId, query.class_id, query.section_id, user);
    if (students.length === 0) return [];

    const records = await this.prisma.attendance_student_daily.findMany({
      where: { date, student_cc: { in: students.map((s) => s.cc) } },
    });
    const recordMap = new Map(records.map((r) => [r.student_cc, r]));

    const rows = await Promise.all(
      students.map(async (student) => {
        const resolved = await this.calendarResolver.resolveStudentDay(
          campusId,
          student.class_id,
          student.section_id,
          date,
        );
        const record = recordMap.get(student.cc) ?? null;
        return {
          student: {
            cc: student.cc,
            full_name: student.full_name,
            gr_number: student.gr_number,
            photo_url: student.photograph_url,
            class: student.classes?.description ?? null,
            section: student.sections?.description ?? null,
          },
          check_in_at: record?.check_in_at ?? null,
          check_out_at: record?.check_out_at ?? null,
          status: record?.status ?? null,
          is_working_day: resolved.isWorkingDay,
          day_type: resolved.dayType,
          day_description: resolved.description,
        };
      }),
    );

    return rows;
  }

  // Derives Working time (IN->OUT) and Break (OUT->IN gaps) segments from the
  // persisted scan sequence. Students don't have reporting/leaving times like
  // staff, so there's no OVERTIME/DAY_OFF distinction here.
  private buildDaySegments(scans: zk_attendance_scans[]): { type: 'WORK' | 'BREAK'; start: string; end: string; isMissingOut?: boolean }[] {
    const segments: { type: 'WORK' | 'BREAK'; start: string; end: string; isMissingOut?: boolean }[] = [];

    for (let i = 0; i + 1 < scans.length; i += 2) {
      const inTime = scans[i].scan_time;
      const outTime = scans[i + 1].scan_time;
      segments.push({ type: 'WORK', start: inTime.toISOString(), end: outTime.toISOString() });

      if (i + 2 < scans.length) {
        segments.push({ type: 'BREAK', start: outTime.toISOString(), end: scans[i + 2].scan_time.toISOString() });
      }
    }

    if (scans.length > 0 && scans.length % 2 !== 0) {
      const lastInTime = scans[scans.length - 1].scan_time;
      const syntheticEnd = new Date(lastInTime.getTime() + 10 * 60 * 1000);
      segments.push({ type: 'WORK', start: lastInTime.toISOString(), end: syntheticEnd.toISOString(), isMissingOut: true });
    }

    return segments;
  }

  async getTimeline(studentCc: number, query: GetStudentTimelineQueryDto, user: IJwtStaffPayload) {
    const student = await this.prisma.students.findUnique({
      where: { cc: studentCc },
      select: { cc: true, full_name: true, campus_id: true, class_id: true, section_id: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    if (student.campus_id) this.assertCampusAccess(user, student.campus_id);

    const dateFrom = this.parseDate(query.date_from);
    const dateTo = this.parseDate(query.date_to);
    if (dateFrom > dateTo) throw new BadRequestException('date_from must be before date_to');

    const [schedules, policySets] = student.campus_id != null
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

    const calendarMap = student.campus_id != null
      ? await this.calendarResolver.loadStudentCalendarMap(
          student.campus_id,
          student.class_id,
          student.section_id,
          dateFrom,
          dateTo,
        )
      : new Map();

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
      status: RollRecordStatus | null;
      is_working_day: boolean;
      day_type: string | null;
      day_description: string | null;
      holiday_type: string | null;
      holiday_description: string | null;
      segments: ReturnType<StudentAttendanceService['buildDaySegments']>;
    }[] = [];
    const todayKey = getTodayKeyKarachi();
    for (let d = new Date(dateFrom); d <= dateTo; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))) {
      const key = d.toISOString();
      const dateKey = key.slice(0, 10);
      const record = recordMap.get(key) ?? null;
      const dayScans = scansByDate.get(key) ?? [];
      const resolved = calendarMap.get(dateKey) ?? {
        isWorkingDay: d.getUTCDay() !== 0 && d.getUTCDay() !== 6,
        dayType: d.getUTCDay() === 0 || d.getUTCDay() === 6 ? ('WEEKEND' as const) : null,
        description: null,
        source: 'DEFAULT' as const,
      };
      const holidayDisplay = this.calendarResolver.toHolidayDisplay(resolved);

      // Resolve check-in policy in memory
      const { expectedCheckIn, graceMinutes } = this.policyResolver.resolveStudentCheckInPolicyFromCache(
        student.class_id,
        d,
        schedules,
        policySets,
      );

      const hasCheckIn = !!record?.check_in_at || dayScans.length > 0;
      const status = resolveStudentAttendanceStatus({
        dateKey,
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
        date: dateKey,
        status,
        is_working_day: resolved.isWorkingDay,
        day_type: resolved.dayType,
        day_description: resolved.description,
        holiday_type: holidayDisplay.holiday_type,
        holiday_description: holidayDisplay.holiday_description,
        segments: (() => {
          // If a MANUAL record with check_in_at was set by an admin, use it for segments instead of raw scans.
          if (record?.source === AttendanceSource.MANUAL && record.check_in_at) {
            const inISO = record.check_in_at.toISOString();
            if (record.check_out_at) {
              return [{ type: 'WORK' as const, start: inISO, end: record.check_out_at.toISOString() }];
            }
            const syntheticEnd = new Date(record.check_in_at.getTime() + 10 * 60 * 1000);
            return [{ type: 'WORK' as const, start: inISO, end: syntheticEnd.toISOString(), isMissingOut: true }];
          }
          return this.buildDaySegments(dayScans);
        })(),
      });
    }

    return {
      student: { cc: student.cc, full_name: student.full_name },
      days,
    };
  }

  // ── Gate-desk quick check-in / check-out ───────────────────────────────────

  // Shared by getQuickCheckState and manualScan: resolves the student, asserts
  // the caller may act on them, and reports whether today is a working day.
  private async loadQuickCheckContext(studentCc: number, user: IJwtStaffPayload) {
    const student = await this.prisma.students.findFirst({
      where: { cc: studentCc, deleted_at: null },
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        photograph_url: true,
        status: true,
        campus_id: true,
        class_id: true,
        section_id: true,
        classes: { select: { description: true } },
        sections: { select: { description: true } },
      },
    });
    if (!student) throw new NotFoundException('Student not found');
    if (student.campus_id) this.assertCampusAccess(user, student.campus_id);
    if (student.class_id) assertClassInScope(user, student.class_id);

    const date = this.parseDate(getTodayKeyKarachi());
    const day = student.campus_id
      ? await this.calendarResolver.resolveStudentDay(
          student.campus_id,
          student.class_id,
          student.section_id,
          date,
        )
      : null;

    return { student, date, day };
  }

  async getQuickCheckState(studentCc: number, user: IJwtStaffPayload) {
    const { student, date, day } = await this.loadQuickCheckContext(studentCc, user);
    const state = await this.processor.getStudentDayState(studentCc, date);

    return {
      student: {
        cc: student.cc,
        full_name: student.full_name,
        gr_number: student.gr_number,
        photo_url: student.photograph_url,
        status: student.status,
        class: student.classes?.description ?? null,
        section: student.sections?.description ?? null,
      },
      date: date.toISOString().slice(0, 10),
      is_working_day: day?.isWorkingDay ?? true,
      day_description: day?.description ?? day?.dayType ?? null,
      next_direction: state.next_direction,
      scan_count: state.scan_count,
      status: state.record?.status ?? null,
      source: state.record?.source ?? null,
      check_in_at: state.record?.check_in_at ?? null,
      check_out_at: state.record?.check_out_at ?? null,
      scans: state.scans.map((s) => ({
        id: s.id,
        scan_time: s.scan_time,
        direction: s.direction,
        is_manual: s.device_sn === MANUAL_DEVICE_SN,
      })),
    };
  }

  async manualScan(studentCc: number, dto: ManualStudentScanDto, user: IJwtStaffPayload) {
    const { student, day } = await this.loadQuickCheckContext(studentCc, user);

    if (student.status !== 'ENROLLED') {
      throw new BadRequestException(
        `${student.full_name} is not currently enrolled (status: ${student.status}).`,
      );
    }
    if (!student.campus_id) {
      throw new BadRequestException(`${student.full_name} has no campus assigned.`);
    }
    if (day && !day.isWorkingDay) {
      throw new BadRequestException(
        `Cannot record attendance on a non-working day: ${day.description ?? day.dayType ?? 'Holiday'}`,
      );
    }

    const result = await this.processor.recordManualStudentScan(
      studentCc,
      dto.direction,
      user.username || user.sub,
    );

    return {
      student_cc: studentCc,
      full_name: student.full_name,
      direction: result.direction,
      scan_time: result.scan.scan_time,
      status: result.record?.status ?? null,
      check_in_at: result.record?.check_in_at ?? null,
      check_out_at: result.record?.check_out_at ?? null,
      // Next punch flips, so the panel can re-label its buttons without a refetch.
      next_direction: result.direction === 'IN' ? 'OUT' : 'IN',
      notified: result.notified,
    };
  }

  async resolveAttendance(studentCc: number, dto: ResolveStudentAttendanceDto, user: IJwtStaffPayload) {
    const student = await this.prisma.students.findUnique({
      where: { cc: studentCc },
      select: { cc: true, campus_id: true, class_id: true, section_id: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    if (student.campus_id) this.assertCampusAccess(user, student.campus_id);

    const date = this.parseDate(dto.date);
    const resolved = await this.calendarResolver.resolveStudentDay(
      dto.campus_id,
      student.class_id,
      student.section_id,
      date,
    );
    if (!resolved.isWorkingDay) {
      throw new BadRequestException(
        `Cannot set manual attendance on a non-working day: ${resolved.description ?? resolved.dayType ?? 'Holiday'}`,
      );
    }

    let checkInAt: Date | undefined;
    let checkOutAt: Date | undefined;

    if (dto.check_in_time) {
      const [h, m] = dto.check_in_time.split(':').map(Number);
      checkInAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, m, 0));
    }
    const [oh, om] = dto.check_out_time.split(':').map(Number);
    checkOutAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), oh, om, 0));

    await this.prisma.attendance_student_daily.upsert({
      where: { student_cc_date: { student_cc: studentCc, date } },
      create: {
        student_cc: studentCc,
        campus_id: dto.campus_id,
        date,
        status: RollRecordStatus.PRESENT,
        source: AttendanceSource.MANUAL,
        marked_by: user.sub,
        ...(checkInAt ? { check_in_at: checkInAt } : {}),
        check_out_at: checkOutAt,
      },
      update: {
        status: RollRecordStatus.PRESENT,
        source: AttendanceSource.MANUAL,
        marked_by: user.sub,
        ...(checkInAt ? { check_in_at: checkInAt } : {}),
        check_out_at: checkOutAt,
      },
    });

    this.auditLogs.log({
      entity_type: 'STUDENT_ATTENDANCE',
      entity_id: String(studentCc),
      action: 'CREATED',
      section: 'attendance',
      new_value: `${dto.date} PRESENT`,
      changed_by: user.username || user.sub,
      student_id: studentCc,
    });
    return { resolved: true, student_cc: studentCc, date: dto.date };
  }

  async bulkManualMark(dto: BulkManualStudentAttendanceDto, user: IJwtStaffPayload) {
    const date = this.parseDate(dto.date);
    this.assertCampusAccess(user, dto.campus_id);

    if (!dto.records?.length) {
      throw new BadRequestException('records are required');
    }

    const requestedCcs = dto.records.map((r) => r.student_cc);
    const uniqueRequestedCcs = Array.from(new Set(requestedCcs));

    // Validate students are enrolled in the requested campus.
    const students = await this.prisma.students.findMany({
      where: {
        cc: { in: uniqueRequestedCcs },
        campus_id: dto.campus_id,
        status: 'ENROLLED',
        deleted_at: null,
      },
      select: { cc: true, class_id: true, section_id: true },
    });

    const found = new Set(students.map((s) => s.cc));
    const missing = uniqueRequestedCcs.filter((cc) => !found.has(cc));
    if (missing.length) {
      throw new BadRequestException(
        `Some students are not enrolled in campus ${dto.campus_id}: ${missing.join(', ')}`,
      );
    }

    // Resolve working day status per student (based on their class/section calendars).
    const resolvedByStudent = new Map<number, { isWorkingDay: boolean; description: string | null; dayType: string | null }>();
    await Promise.all(
      students.map(async (s) => {
        const resolved = await this.calendarResolver.resolveStudentDay(
          dto.campus_id,
          s.class_id,
          s.section_id,
          date,
        );
        resolvedByStudent.set(s.cc, {
          isWorkingDay: resolved.isWorkingDay,
          description: resolved.description,
          dayType: resolved.dayType,
        });
      }),
    );

    // Fetch existing manual timestamps so we can preserve them when re-marking PRESENT/LATE.
    const existingRecords = await this.prisma.attendance_student_daily.findMany({
      where: {
        date,
        student_cc: { in: uniqueRequestedCcs },
      },
      select: {
        student_cc: true,
        source: true,
        check_in_at: true,
        check_out_at: true,
        last_scan_at: true,
      },
    });
    const existingMap = new Map(existingRecords.map((r) => [r.student_cc, r]));

    const upserts = dto.records.map(async (mark) => {
      const studentCc = mark.student_cc;
      const resolved = resolvedByStudent.get(studentCc);
      if (!resolved) {
        throw new BadRequestException(`Student CC ${studentCc} not found in campus roster.`);
      }

      if (!resolved.isWorkingDay && mark.status !== RollRecordStatus.EXCUSED) {
        throw new BadRequestException(
          `Cannot set ${mark.status} on a non-working day for student ${studentCc}: ${
            resolved.description ?? resolved.dayType ?? 'Holiday'
          }`,
        );
      }

      const existing = existingMap.get(studentCc);
      const preserveTimes = existing?.source === AttendanceSource.MANUAL;

      const shouldHaveTimes =
        mark.status === RollRecordStatus.PRESENT || mark.status === RollRecordStatus.LATE;

      return this.prisma.attendance_student_daily.upsert({
        where: { student_cc_date: { student_cc: studentCc, date } },
        create: {
          student_cc: studentCc,
          campus_id: dto.campus_id,
          date,
          status: mark.status,
          source: AttendanceSource.MANUAL,
          marked_by: user.sub,
          check_in_at: shouldHaveTimes && preserveTimes ? existing?.check_in_at : null,
          check_out_at: shouldHaveTimes && preserveTimes ? existing?.check_out_at : null,
          last_scan_at: shouldHaveTimes && preserveTimes ? existing?.last_scan_at : null,
        },
        update: {
          status: mark.status,
          source: AttendanceSource.MANUAL,
          marked_by: user.sub,
          check_in_at: shouldHaveTimes && preserveTimes ? existing?.check_in_at : null,
          check_out_at: shouldHaveTimes && preserveTimes ? existing?.check_out_at : null,
          last_scan_at: shouldHaveTimes && preserveTimes ? existing?.last_scan_at : null,
        },
      });
    });

    await this.prisma.$transaction(upserts);

    void this.auditLogs.log({
      entity_type: 'STUDENT_ATTENDANCE',
      entity_id: `BULK:${dto.campus_id}:${dto.date}`,
      action: 'UPDATED',
      section: 'attendance',
      new_value: `bulk manual mark (${uniqueRequestedCcs.length})`,
      changed_by: user.username || user.sub,
      student_id: null,
      note: `Marked ${uniqueRequestedCcs.length} student(s) for ${dto.date} (manual).`,
    });

    return { saved_count: uniqueRequestedCcs.length };
  }
}
