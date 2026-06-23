import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RollRecordStatus, zk_attendance_scans, AttendanceSource } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { assertClassInScope } from '../../common/staff-scope';
import { CalendarDayResolverService } from '../hr/calendar/calendar-day-resolver.service';
import { HolidayAttendanceSyncService } from '../hr/calendar/holiday-attendance-sync.service';
import { resolveStudentAttendanceStatus, getTodayKeyKarachi } from './student-attendance-status.util';
import {
  GetStudentAttendanceQueryDto,
  GetStudentTimelineQueryDto,
} from './dto/student-attendance.dto';
import { AttendancePolicyResolverService } from './attendance-policy-resolver.service';

@Injectable()
export class StudentAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly holidaySync: HolidayAttendanceSyncService,
    private readonly policyResolver: AttendancePolicyResolverService,
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
  private buildDaySegments(scans: zk_attendance_scans[]) {
    const segments: { type: 'WORK' | 'BREAK'; start: string; end: string }[] = [];

    for (let i = 0; i + 1 < scans.length; i += 2) {
      const inTime = scans[i].scan_time;
      const outTime = scans[i + 1].scan_time;
      segments.push({ type: 'WORK', start: inTime.toISOString(), end: outTime.toISOString() });

      if (i + 2 < scans.length) {
        segments.push({ type: 'BREAK', start: outTime.toISOString(), end: scans[i + 2].scan_time.toISOString() });
      }
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
        segments: this.buildDaySegments(dayScans),
      });
    }

    return {
      student: { cc: student.cc, full_name: student.full_name },
      days,
    };
  }
}
