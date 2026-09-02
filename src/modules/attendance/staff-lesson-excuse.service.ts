import { Injectable } from '@nestjs/common';
import { AttendanceSource, StaffAttendanceStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export type StaffExcuseResult = {
  staffExcused: boolean;
  staffExcuseWarning: string | null;
};

@Injectable()
export class StaffLessonExcuseService {
  constructor(private readonly prisma: PrismaService) {}

  formatDateLabel(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /**
   * Upsert EXCUSED on Staff Register for a missed lesson when makeup is confirmed.
   * Resolves campus from employee profile (O-Level section slots) with optional override.
   */
  async excuseTeacherForMissedLesson(params: {
    employeeId: number;
    sourceDate: Date;
    makeupDate: Date;
    sourceSlotId: number;
    campusId?: number;
  }): Promise<StaffExcuseResult> {
    const { employeeId, sourceDate, makeupDate, sourceSlotId, campusId: campusOverride } =
      params;

    const sourceDow = sourceDate.getUTCDay();
    const otherSlots = await this.prisma.timetable_slots.count({
      where: {
        employee_id: employeeId,
        day_of_week: sourceDow,
        id: { not: sourceSlotId },
        timetables: { is_active: true },
      },
    });

    if (otherSlots > 0) {
      return {
        staffExcused: false,
        staffExcuseWarning:
          'Teacher has other timetable slots on the source day — staff register was not auto-updated. Mark manually in Staff Register.',
      };
    }

    let campusId = campusOverride;
    if (!campusId) {
      const employee = await this.prisma.employee_profiles.findUnique({
        where: { id: employeeId },
        select: { campus_id: true },
      });
      campusId = employee?.campus_id ?? undefined;
    }

    if (!campusId) {
      const slot = await this.prisma.timetable_slots.findUnique({
        where: { id: sourceSlotId },
        select: { timetables: { select: { campus_id: true } } },
      });
      campusId = slot?.timetables.campus_id;
    }

    if (!campusId) {
      return { staffExcused: false, staffExcuseWarning: 'Could not resolve teacher campus.' };
    }

    const note = `Makeup class held ${this.formatDateLabel(makeupDate)} (rescheduled from ${this.formatDateLabel(sourceDate)})`;

    await this.prisma.attendance_staff_daily.upsert({
      where: {
        employee_id_date: { employee_id: employeeId, date: sourceDate },
      },
      create: {
        employee_id: employeeId,
        campus_id: campusId,
        date: sourceDate,
        status: StaffAttendanceStatus.EXCUSED,
        source: AttendanceSource.SYSTEM,
        notes: note,
      },
      update: {
        status: StaffAttendanceStatus.EXCUSED,
        source: AttendanceSource.SYSTEM,
        notes: note,
      },
    });

    return { staffExcused: true, staffExcuseWarning: null };
  }
}
