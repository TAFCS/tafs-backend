import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AttendanceSource, RollRecordStatus, StaffAttendanceStatus, student_status } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { CalendarDayResolverService } from './calendar-day-resolver.service';

export interface HolidaySyncResult {
  students: number;
  staff: number;
  skipped_manual: number;
}

@Injectable()
export class HolidayAttendanceSyncService {
  private readonly logger = new Logger(HolidayAttendanceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarResolver: CalendarDayResolverService,
  ) {}

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

  async syncCampusForDate(
    campusId: number,
    date: Date,
    options?: { force?: boolean },
  ): Promise<HolidaySyncResult> {
    let students = 0;
    let staff = 0;
    let skippedManual = 0;
    const force = options?.force ?? false;

    const enrolledStudents = await this.prisma.students.findMany({
      where: {
        campus_id: campusId,
        status: student_status.ENROLLED,
        deleted_at: null,
      },
      select: { cc: true, class_id: true, section_id: true, campus_id: true },
    });

    for (const student of enrolledStudents) {
      if (!student.campus_id) continue;
      const resolved = await this.calendarResolver.resolveStudentDay(
        student.campus_id,
        student.class_id,
        student.section_id,
        date,
      );
      if (resolved.isWorkingDay) continue;

      const existing = await this.prisma.attendance_student_daily.findUnique({
        where: { student_cc_date: { student_cc: student.cc, date } },
      });
      if (existing?.source === AttendanceSource.MANUAL && !force) {
        skippedManual++;
        continue;
      }
      if (existing?.source === AttendanceSource.BIOMETRIC && !force) {
        continue;
      }

      const description = resolved.description ?? 'Holiday';
      await this.prisma.attendance_student_daily.upsert({
        where: { student_cc_date: { student_cc: student.cc, date } },
        create: {
          student_cc: student.cc,
          campus_id: student.campus_id,
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
      });
      students++;
    }

    const employees = await this.prisma.employee_profiles.findMany({
      where: {
        campus_id: campusId,
        users: { is_active: true, deleted_at: null },
      },
      select: { id: true, campus_id: true },
    });

    for (const employee of employees) {
      if (!employee.campus_id) continue;
      const resolved = await this.calendarResolver.resolveStaffDay(employee.id, employee.campus_id, date);
      if (resolved.isWorkingDay) continue;

      const existing = await this.prisma.attendance_staff_daily.findUnique({
        where: { employee_id_date: { employee_id: employee.id, date } },
      });
      if (existing?.source === AttendanceSource.MANUAL && !force) {
        skippedManual++;
        continue;
      }

      const description = resolved.description ?? 'Day off';
      await this.prisma.attendance_staff_daily.upsert({
        where: { employee_id_date: { employee_id: employee.id, date } },
        create: {
          employee_id: employee.id,
          campus_id: employee.campus_id,
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
      });
      staff++;
    }

    return { students, staff, skipped_manual: skippedManual };
  }

  async syncAllCampusesForDate(date: Date): Promise<void> {
    const campuses = await this.prisma.campuses.findMany({ select: { id: true } });

    for (const campus of campuses) {
      try {
        const result = await this.syncCampusForDate(campus.id, date);
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
  }

  async syncAllCampusesForToday(): Promise<void> {
    await this.syncAllCampusesForDate(this.todayUtcDate());
  }

  /** Fire-and-forget after calendar CRUD — never blocks the save response. */
  async syncAfterCalendarChange(campusId: number, dateStr: string): Promise<HolidaySyncResult | null> {
    try {
      const date = this.parseDateKey(dateStr);
      const result = await this.syncCampusForDate(campusId, date);
      if (result.students > 0 || result.staff > 0) {
        this.logger.log(
          `Calendar change → campus ${campusId} ${dateStr}: EXCUSED ${result.students} students, ${result.staff} staff`,
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
    if (resolved.isWorkingDay) return false;

    const existing = await this.prisma.attendance_student_daily.findUnique({
      where: { student_cc_date: { student_cc: studentCc, date } },
    });
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
