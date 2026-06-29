import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AttendanceSource, StaffAttendanceStatus } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { CalendarDayResolverService } from '../calendar/calendar-day-resolver.service';

@Injectable()
export class LeaveAttendanceSyncService {
  private readonly logger = new Logger(LeaveAttendanceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarResolver: CalendarDayResolverService,
  ) {}

  leaveNote(requestId: number): string {
    return `leave_request:${requestId}`;
  }

  async syncApprovedLeaveToAttendance(requestId: number): Promise<number> {
    const request = await this.prisma.leave_requests.findUnique({
      where: { id: requestId },
      include: {
        leave_types: { select: { code: true } },
        employee_profiles: { select: { id: true, campus_id: true } },
      },
    });
    if (!request) {
      throw new BadRequestException(`Leave request ${requestId} not found`);
    }
    if (!request.employee_profiles.campus_id) {
      throw new BadRequestException('Employee has no campus assigned — cannot sync attendance');
    }

    const leaveCode = request.leave_types.code;
    if (!leaveCode) {
      throw new BadRequestException('Leave type is not configured');
    }

    const status = this.leaveCodeToStatus(leaveCode);
    const notes = this.leaveNote(requestId);
    const campusId = request.employee_profiles.campus_id;
    let synced = 0;

    for (const date of this.expandDateRange(request.start_date, request.end_date)) {
      const resolved = await this.calendarResolver.resolveStaffDay(
        request.employee_id,
        campusId,
        date,
      );
      if (!resolved.isWorkingDay) continue;

      const existing = await this.prisma.attendance_staff_daily.findUnique({
        where: { employee_id_date: { employee_id: request.employee_id, date } },
      });
      if (existing?.source === AttendanceSource.MANUAL) continue;

      await this.prisma.attendance_staff_daily.upsert({
        where: { employee_id_date: { employee_id: request.employee_id, date } },
        create: {
          employee_id: request.employee_id,
          campus_id: campusId,
          date,
          status,
          source: AttendanceSource.LEAVE,
          notes,
        },
        update: {
          status,
          source: AttendanceSource.LEAVE,
          notes,
        },
      });
      synced++;
    }

    this.logger.log(`Synced ${synced} attendance rows for leave request ${requestId}`);
    return synced;
  }

  async revertLeaveAttendance(requestId: number): Promise<number> {
    const notes = this.leaveNote(requestId);
    const deleted = await this.prisma.attendance_staff_daily.deleteMany({
      where: {
        source: AttendanceSource.LEAVE,
        notes,
      },
    });
    if (deleted.count > 0) {
      this.logger.log(`Reverted ${deleted.count} attendance rows for leave request ${requestId}`);
    }
    return deleted.count;
  }

  private leaveCodeToStatus(code: string): StaffAttendanceStatus {
    switch (code) {
      case 'SICK':    return StaffAttendanceStatus.SICK_LEAVE;
      case 'CASUAL':  return StaffAttendanceStatus.CASUAL_LEAVE;
      case 'ANNUAL':  return StaffAttendanceStatus.ANNUAL_LEAVE;
      case 'UNPAID':  return StaffAttendanceStatus.UNPAID_LEAVE;
      default:        return StaffAttendanceStatus.EXCUSED;
    }
  }

  private expandDateRange(start: Date, end: Date): Date[] {
    const dates: Date[] = [];
    const cursor = new Date(start);
    cursor.setUTCHours(0, 0, 0, 0);
    const endDate = new Date(end);
    endDate.setUTCHours(0, 0, 0, 0);
    while (cursor <= endDate) {
      dates.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
  }
}
