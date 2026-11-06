import { PERIOD_TIMINGS_SELECT, scheduleFromSnapshot, timingsOnDate } from '../employees/timings-history.util';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AttendanceSource, CheckInSource, DevicePersonType, Prisma, RollRecordStatus, StaffAttendanceStatus, student_status } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { CalendarDayResolverService } from './calendar-day-resolver.service';
import { CalendarNotificationService } from './calendar-notification.service';
import { ZkAttendanceProcessorService } from '../../attendance/zk-attendance-processor.service';

export interface HolidaySyncResult {
  students: number;
  staff: number;
  cleared_students: number;
  cleared_staff: number;
  skipped_manual: number;
  /** TAFSD-463: people whose day became working and was rebuilt from that day's punches. */
  rebuilt_students: number;
  rebuilt_staff: number;
}

@Injectable()
export class HolidayAttendanceSyncService {
  private readonly logger = new Logger(HolidayAttendanceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly notificationService: CalendarNotificationService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Looked up at call time, not injected: AttendanceModule imports HrModule,
   * so constructor-injecting the processor here would be a module cycle.
   */
  private dayRebuilder(): ZkAttendanceProcessorService | null {
    try {
      return this.moduleRef.get(ZkAttendanceProcessorService, { strict: false });
    } catch {
      return null;
    }
  }

  parseDateKey(dateStr: string): Date {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private todayUtcDate(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  /** Runs promise-returning thunks with bounded concurrency instead of either
   *  fully sequential (slow) or fully parallel (can exhaust the DB pool). */
  private async runInBatches<T>(thunks: (() => Promise<T>)[], batchSize = 20): Promise<void> {
    for (let i = 0; i < thunks.length; i += batchSize) {
      await Promise.all(thunks.slice(i, i + batchSize).map((thunk) => thunk()));
    }
  }

  async syncCampusForDate(
    campusId: number,
    date: Date,
    options?: {
      force?: boolean;
      /** Skip the student half (staff-only recompute). */
      skipStudents?: boolean;
      /** Skip the staff half (students-only recompute). */
      skipStaff?: boolean;
      /** Narrow the staff half, e.g. to one department or staff category. */
      employeeWhere?: Prisma.employee_profilesWhereInput;
      /**
       * TAFSD-463: rebuild, from that day's punches, every person whose day
       * now resolves as working but has no attendance row (or only the
       * day-off row this sync just cleared). Default true. Recompute Status
       * passes false because it rebuilds the whole range itself.
       */
      rebuildFromScans?: boolean;
    },
  ): Promise<HolidaySyncResult> {
    let students = 0;
    let staff = 0;
    let clearedStudents = 0;
    let clearedStaff = 0;
    let skippedManual = 0;
    const force = options?.force ?? false;
    // A day that just became working (a past Saturday opened, a holiday
    // removed) is left with no row: the day-off row is deleted above and the
    // punches that came in while it was off were never turned into one. The
    // staff app and the attendance modal read that row, so without a rebuild
    // the day showed wrong until someone ran Recompute Status by hand.
    const staffToRebuild: number[] = [];
    const studentsToRebuild: number[] = [];

    // ── Students ──────────────────────────────────────────────────────────
    // Batched: one query for the calendar rows and one for existing attendance
    // (instead of two DB round trips per student), then writes run with bounded
    // concurrency instead of fully sequential — this used to be the dominant
    // cost of a calendar-change sync on campuses with large rosters.
    const enrolledStudents = options?.skipStudents
      ? []
      : await this.prisma.students.findMany({
          where: {
            campus_id: campusId,
            status: student_status.ENROLLED,
            deleted_at: null,
          },
          select: { cc: true, class_id: true, section_id: true, campus_id: true },
        });

    if (enrolledStudents.length > 0) {
      const studentCalendarRows = await this.calendarResolver.loadStudentCalendarRowsForDate(campusId, date);
      const existingStudentAttendance = await this.prisma.attendance_student_daily.findMany({
        where: { student_cc: { in: enrolledStudents.map((s) => s.cc) }, date },
      });
      const existingByStudent = new Map(existingStudentAttendance.map((r) => [r.student_cc, r]));

      const studentWrites: (() => Promise<unknown>)[] = [];
      for (const student of enrolledStudents) {
        if (!student.campus_id) continue;
        const resolved = this.calendarResolver.resolveStudentDayFromRows(
          studentCalendarRows,
          student.class_id,
          student.section_id,
          date,
        );
        const existing = existingByStudent.get(student.cc);

        if (resolved.isWorkingDay) {
          if (!existing || existing.source === AttendanceSource.SYSTEM) studentsToRebuild.push(student.cc);
          if (existing?.source === AttendanceSource.SYSTEM) {
            clearedStudents++;
            studentWrites.push(() =>
              this.prisma.attendance_student_daily.deleteMany({
                where: { student_cc: student.cc, date, source: AttendanceSource.SYSTEM },
              }),
            );
          }
          continue;
        }
        if (existing?.source === AttendanceSource.MANUAL && !force) {
          skippedManual++;
          continue;
        }
        if (existing?.source === AttendanceSource.BIOMETRIC && !force) {
          continue;
        }

        const description = resolved.description ?? 'Holiday';
        students++;
        // Already the row we'd write — re-syncing an unchanged day is read-only.
        if (
          existing?.source === AttendanceSource.SYSTEM &&
          existing.status === RollRecordStatus.EXCUSED &&
          existing.notes === description
        ) {
          continue;
        }
        studentWrites.push(() =>
          this.prisma.attendance_student_daily.upsert({
            where: { student_cc_date: { student_cc: student.cc, date } },
            create: {
              student_cc: student.cc,
              campus_id: student.campus_id!,
              date,
              status: RollRecordStatus.EXCUSED,
              source: AttendanceSource.SYSTEM,
              notes: description,
            },
            update: {
              status: RollRecordStatus.EXCUSED,
              source: AttendanceSource.SYSTEM,
              notes: description,
            },
          }),
        );
      }
      await this.runInBatches(studentWrites);
    }

    // ── Staff ─────────────────────────────────────────────────────────────
    const employees = options?.skipStaff
      ? []
      : await this.prisma.employee_profiles.findMany({
          where: {
            ...(options?.employeeWhere ?? {}),
            campus_id: campusId,
            users: { is_active: true, deleted_at: null },
          },
          select: {
            id: true,
            campus_id: true,
            department_id: true,
            staff_category_id: true,
            days_per_week: true,
            check_in_source: true,
            staff_categories: { select: { code: true } },
            employee_work_schedules: { select: { day_of_week: true, is_working: true } },
            // TAFSD-277: the working days in effect on `date`, not today's.
            employee_progression_periods: { select: PERIOD_TIMINGS_SELECT },
          },
        });
    for (const employee of employees) {
      const snapshot = timingsOnDate(employee.employee_progression_periods ?? [], date);
      if (snapshot) Object.assign(employee, scheduleFromSnapshot(snapshot));
    }

    if (employees.length > 0) {
      const staffCalendarRows = await this.calendarResolver.loadStaffCalendarRows(campusId, date, date);
      const employeeIds = employees.map((e) => e.id);
      const existingStaffAttendance = await this.prisma.attendance_staff_daily.findMany({
        where: { employee_id: { in: employeeIds }, date },
      });
      const existingByEmployee = new Map(existingStaffAttendance.map((r) => [r.employee_id, r]));
      // Mandatory-Saturday overrides only ever matter on a Saturday (see
      // applyMandatorySaturdayFromSet), so skip the extra query otherwise.
      const mandatorySaturdayMap =
        date.getUTCDay() === 6
          ? await this.calendarResolver.loadMandatorySaturdayDatesForEmployees(employeeIds, date, date)
          : new Map<number, Set<string>>();
      // TIMETABLE teachers work the days they have slots (plus makeups and
      // shift overrides), not a days_per_week default. Without this, a
      // teacher with Saturday slots was stamped EXCUSED – Weekend every
      // Saturday and their punches never counted.
      const timetableContext = await this.calendarResolver.loadStaffTimetableContextForEmployees(
        employees.filter((e) => e.check_in_source === CheckInSource.TIMETABLE).map((e) => e.id),
        date,
        date,
      );

      const staffWrites: (() => Promise<unknown>)[] = [];
      for (const employee of employees) {
        if (!employee.campus_id) continue;
        const resolved = this.calendarResolver.resolveStaffDayFromRows(
          staffCalendarRows,
          date,
          employee.id,
          employee.department_id,
          employee.staff_category_id,
          employee.staff_categories?.code ?? null,
          employee.days_per_week,
          employee.employee_work_schedules,
          mandatorySaturdayMap.get(employee.id),
          employee.check_in_source,
          timetableContext.get(employee.id)?.timetableActiveDays,
          timetableContext.get(employee.id)?.makeupRescheduleDates,
          timetableContext.get(employee.id)?.shiftOverrideDates,
        );
        const existing = existingByEmployee.get(employee.id);

        if (resolved.isWorkingDay) {
          if (!existing || existing.source === AttendanceSource.SYSTEM) staffToRebuild.push(employee.id);
          if (existing?.source === AttendanceSource.SYSTEM) {
            clearedStaff++;
            staffWrites.push(() =>
              this.prisma.attendance_staff_daily.deleteMany({
                where: { employee_id: employee.id, date, source: AttendanceSource.SYSTEM },
              }),
            );
          }
          continue;
        }
        if (existing?.source === AttendanceSource.MANUAL && !force) {
          skippedManual++;
          continue;
        }
        if (existing?.source === AttendanceSource.LEAVE && !force) {
          skippedManual++;
          continue;
        }

        const description = resolved.description ?? 'Day off';
        staff++;
        if (
          existing?.source === AttendanceSource.SYSTEM &&
          existing.status === StaffAttendanceStatus.EXCUSED &&
          existing.notes === description
        ) {
          continue;
        }
        staffWrites.push(() =>
          this.prisma.attendance_staff_daily.upsert({
            where: { employee_id_date: { employee_id: employee.id, date } },
            create: {
              employee_id: employee.id,
              campus_id: employee.campus_id!,
              date,
              status: StaffAttendanceStatus.EXCUSED,
              source: AttendanceSource.SYSTEM,
              notes: description,
            },
            update: {
              status: StaffAttendanceStatus.EXCUSED,
              source: AttendanceSource.SYSTEM,
              notes: description,
            },
          }),
        );
      }
      await this.runInBatches(staffWrites);
    }

    let rebuiltStudents = 0;
    let rebuiltStaff = 0;
    if (
      (options?.rebuildFromScans ?? true) &&
      date.getTime() <= this.todayUtcDate().getTime() &&
      (staffToRebuild.length > 0 || studentsToRebuild.length > 0)
    ) {
      ({ rebuiltStaff, rebuiltStudents } = await this.rebuildFromScans(date, staffToRebuild, studentsToRebuild));
    }

    // Day-off alerts are for today and upcoming days only. Re-syncing a past
    // date (Recompute Status over a range, opening an old register day) must
    // never push "school is closed on <a date weeks ago>" to parents — and
    // these two steps resolve every student one by one, which made a range
    // re-sync take ~45s per day.
    if (!options?.skipStudents && date.getTime() >= this.todayUtcDate().getTime()) {
      await this.notificationService.clearStaleDayOffAlerts(campusId, date);
      await this.notificationService.notifyDayOffForCampusDate(campusId, date);
    }

    return {
      students,
      staff,
      cleared_students: clearedStudents,
      cleared_staff: clearedStaff,
      skipped_manual: skippedManual,
      rebuilt_students: rebuiltStudents,
      rebuilt_staff: rebuiltStaff,
    };
  }

  /** Only the candidates who actually punched that day are rebuilt. */
  private async rebuildFromScans(
    date: Date,
    employeeIds: number[],
    studentCcs: number[],
  ): Promise<{ rebuiltStaff: number; rebuiltStudents: number }> {
    const rebuilder = this.dayRebuilder();
    if (!rebuilder) {
      this.logger.warn(`Attendance processor unavailable — ${date.toISOString().slice(0, 10)} not rebuilt from scans`);
      return { rebuiltStaff: 0, rebuiltStudents: 0 };
    }

    const [staffScans, studentScans] = await Promise.all([
      employeeIds.length
        ? this.prisma.zk_attendance_scans.findMany({
            where: {
              person_type: DevicePersonType.STAFF,
              employee_id: { in: employeeIds },
              attendance_date: date,
              is_duplicate: false,
            },
            select: { employee_id: true },
            distinct: ['employee_id'],
          })
        : Promise.resolve([]),
      studentCcs.length
        ? this.prisma.zk_attendance_scans.findMany({
            where: {
              person_type: DevicePersonType.STUDENT,
              student_cc: { in: studentCcs },
              attendance_date: date,
              is_duplicate: false,
            },
            select: { student_cc: true },
            distinct: ['student_cc'],
          })
        : Promise.resolve([]),
    ]);

    let rebuiltStaff = 0;
    let rebuiltStudents = 0;
    const writes: (() => Promise<unknown>)[] = [];
    for (const { employee_id } of staffScans) {
      if (employee_id == null) continue;
      writes.push(async () => {
        try {
          const seg = await rebuilder.recomputeDaySequence(DevicePersonType.STAFF, employee_id, null, date);
          await rebuilder.upsertStaffDaily(employee_id, date, seg);
          rebuiltStaff++;
        } catch (err) {
          this.logger.error(`Rebuild failed for employee ${employee_id} on ${date.toISOString().slice(0, 10)}: ${(err as Error).message}`);
        }
      });
    }
    for (const { student_cc } of studentScans) {
      if (student_cc == null) continue;
      writes.push(async () => {
        try {
          const seg = await rebuilder.recomputeDaySequence(DevicePersonType.STUDENT, null, student_cc, date);
          await rebuilder.upsertStudentDaily(student_cc, date, seg, 'calendar-change');
          rebuiltStudents++;
        } catch (err) {
          this.logger.error(`Rebuild failed for student ${student_cc} on ${date.toISOString().slice(0, 10)}: ${(err as Error).message}`);
        }
      });
    }
    await this.runInBatches(writes, 10);
    return { rebuiltStaff, rebuiltStudents };
  }

  async syncAllCampusesForDate(
    date: Date,
    options?: { force?: boolean },
  ): Promise<HolidaySyncResult> {
    const campuses = await this.prisma.campuses.findMany({ select: { id: true } });
    const totals: HolidaySyncResult = {
      students: 0,
      staff: 0,
      cleared_students: 0,
      cleared_staff: 0,
      skipped_manual: 0,
      rebuilt_students: 0,
      rebuilt_staff: 0,
    };

    for (const campus of campuses) {
      try {
        const result = await this.syncCampusForDate(campus.id, date, options);
        totals.students += result.students;
        totals.staff += result.staff;
        totals.cleared_students += result.cleared_students;
        totals.cleared_staff += result.cleared_staff;
        totals.skipped_manual += result.skipped_manual;
        totals.rebuilt_students += result.rebuilt_students;
        totals.rebuilt_staff += result.rebuilt_staff;
        if (result.students > 0 || result.staff > 0) {
          this.logger.log(
            `Campus ${campus.id}: auto-EXCUSED ${result.students} students, ${result.staff} staff for ${date.toISOString().slice(0, 10)}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Holiday sync failed for campus ${campus.id}: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }

    return totals;
  }

  async syncAllCampusesForToday(): Promise<void> {
    await this.syncAllCampusesForDate(this.todayUtcDate());
  }

  /** Fire-and-forget after calendar CRUD — never blocks the save response. */
  async syncAfterCalendarChange(campusId: number, dateStr: string): Promise<HolidaySyncResult | null> {
    try {
      const date = this.parseDateKey(dateStr);
      const result = await this.syncCampusForDate(campusId, date);
      if (
        result.students > 0 ||
        result.staff > 0 ||
        result.cleared_students > 0 ||
        result.cleared_staff > 0 ||
        result.rebuilt_students > 0 ||
        result.rebuilt_staff > 0
      ) {
        this.logger.log(
          `Calendar change → campus ${campusId} ${dateStr}: EXCUSED ${result.students} students, ${result.staff} staff; cleared ${result.cleared_students} students, ${result.cleared_staff} staff; rebuilt ${result.rebuilt_students} students, ${result.rebuilt_staff} staff`,
        );
      }
      return result;
    } catch (err) {
      this.logger.error(
        `Calendar attendance sync failed for campus ${campusId} on ${dateStr}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Ensure a single student has holiday record if applicable (on-demand). */
  async ensureStudentHolidayRecord(
    studentCc: number,
    campusId: number,
    classId: number | null,
    sectionId: number | null,
    date: Date,
  ): Promise<boolean> {
    const resolved = await this.calendarResolver.resolveStudentDay(campusId, classId, sectionId, date);

    const existing = await this.prisma.attendance_student_daily.findUnique({
      where: { student_cc_date: { student_cc: studentCc, date } },
    });

    if (resolved.isWorkingDay) {
      if (existing?.source === AttendanceSource.SYSTEM) {
        await this.prisma.attendance_student_daily.delete({
          where: { student_cc_date: { student_cc: studentCc, date } },
        });
        return true;
      }
      return false;
    }

    if (existing?.source === AttendanceSource.MANUAL) return false;
    if (existing?.source === AttendanceSource.BIOMETRIC) return false;

    await this.prisma.attendance_student_daily.upsert({
      where: { student_cc_date: { student_cc: studentCc, date } },
      create: {
        student_cc: studentCc,
        campus_id: campusId,
        date,
        status: RollRecordStatus.EXCUSED,
        source: AttendanceSource.SYSTEM,
        notes: resolved.description ?? 'Holiday',
      },
      update: {
        status: RollRecordStatus.EXCUSED,
        source: AttendanceSource.SYSTEM,
        notes: resolved.description ?? 'Holiday',
      },
    });
    return true;
  }
}
