import { Controller, Get, HttpStatus, Query, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AttendanceSource, StaffAttendanceStatus } from '@prisma/client';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { TimetablesService } from './timetables.service';
import { ClassPeriodsService } from './class-periods.service';

@ApiTags('Timetables Self')
@ApiBearerAuth()
@Controller('timetables')
@UseGuards(JwtStaffGuard)
export class TimetablesSelfController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: TimetablesService,
    private readonly classPeriods: ClassPeriodsService,
  ) {}

  @Get('me')
  async getMine(@CurrentUser() user: IJwtStaffPayload) {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { user_id: user.sub },
      select: { id: true },
    });
    if (!employee) {
      throw new NotFoundException('No employee profile linked to this account');
    }

    const slots = await this.service.listTeacherWeeklySlots(employee.id);
    // Each slot's own class may run a different bell schedule, so times are
    // resolved per (campus, class, block) rather than off one shared list.
    const periods = await this.classPeriods.resolveMany(
      slots.map((slot) => ({
        campus_id: slot.timetables.campus_id,
        class_id: slot.timetables.class_id,
        block_number: slot.block_number,
      })),
    );

    const data = slots.map((slot) => {
      const period = periods.get(
        `${slot.timetables.campus_id}:${slot.timetables.class_id}:${slot.block_number}`,
      );
      return {
        ...slot,
        start_time: period?.start_time ?? null,
        end_time: period?.end_time ?? null,
        label: period?.label ?? null,
      };
    });

    return createApiResponse(data, HttpStatus.OK, 'Weekly schedule retrieved');
  }

  @Get('me/week-status')
  async getWeekStatus(
    @CurrentUser() user: IJwtStaffPayload,
    @Query('dates') datesParam: string,
  ) {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { user_id: user.sub },
      select: { id: true },
    });
    if (!employee) {
      throw new NotFoundException('No employee profile linked to this account');
    }

    const dateStrings = datesParam
      ? datesParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (dateStrings.length === 0) {
      return createApiResponse({ statuses: {} }, HttpStatus.OK, 'Week statuses retrieved');
    }

    const parsedDates = dateStrings.map((d) => new Date(`${d}T00:00:00.000Z`));
    const minDate = new Date(Math.min(...parsedDates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...parsedDates.map((d) => d.getTime())));

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const slots = await this.prisma.timetable_slots.findMany({
      where: {
        employee_id: employee.id,
        timetables: { is_active: true },
      },
      select: {
        id: true,
        day_of_week: true,
        block_number: true,
        timetables: {
          select: {
            effective_from: true,
            academic_year: true,
          },
        },
      },
    });

    const [reschedules, staffRows, scans, rollSessions] = await Promise.all([
      this.prisma.staff_lesson_reschedules.findMany({
        where: {
          employee_id: employee.id,
          status: { in: ['SCHEDULED', 'COMPLETED'] },
          OR: [
            { source_date: { gte: minDate, lte: maxDate } },
            { makeup_date: { gte: minDate, lte: maxDate } },
          ],
        },
        select: {
          id: true,
          source_timetable_slot_id: true,
          source_date: true,
          makeup_date: true,
          makeup_timetable_slot_id: true,
          makeup_period: true,
          status: true,
        },
      }),
      this.prisma.attendance_staff_daily.findMany({
        where: {
          employee_id: employee.id,
          date: { gte: minDate, lte: maxDate },
        },
        select: {
          date: true,
          status: true,
          check_in_at: true,
          source: true,
          notes: true,
        },
      }),
      this.prisma.zk_attendance_scans.findMany({
        where: {
          employee_id: employee.id,
          person_type: 'STAFF',
          is_duplicate: false,
          attendance_date: { gte: minDate, lte: maxDate },
        },
        select: { attendance_date: true },
      }),
      this.prisma.attendance_roll_sessions.findMany({
        where: {
          snapshot_employee_id: employee.id,
          session_date: { gte: minDate, lte: maxDate },
        },
        select: {
          id: true,
          session_date: true,
          period: true,
          status: true,
          session_kind: true,
          timetable_slot_id: true,
        },
      }),
    ]);

    const dateKey = (d: Date) => d.toISOString().slice(0, 10);
    const staffByDate = new Map(staffRows.map((r) => [dateKey(r.date), r]));
    const scanDates = new Set(scans.map((s) => dateKey(s.attendance_date)));

    const rollBySlotKey = new Map<string, (typeof rollSessions)[number]>();
    const rollByBlockKey = new Map<string, (typeof rollSessions)[number]>();
    for (const rs of rollSessions) {
      const rsIso = dateKey(rs.session_date);
      if (rs.timetable_slot_id) {
        rollBySlotKey.set(`${rs.timetable_slot_id}_${rsIso}`, rs);
      }
      rollByBlockKey.set(`${rs.period}_${rsIso}`, rs);
    }

    const sourceRescheduleByKey = new Map<string, (typeof reschedules)[number]>();
    const makeupRescheduleByKey = new Map<string, (typeof reschedules)[number]>();
    for (const r of reschedules) {
      if (r.source_timetable_slot_id) {
        sourceRescheduleByKey.set(`${r.source_timetable_slot_id}_${dateKey(r.source_date)}`, r);
      }
      if (r.makeup_timetable_slot_id) {
        makeupRescheduleByKey.set(`${r.makeup_timetable_slot_id}_${dateKey(r.makeup_date)}`, r);
      }
    }

    const statuses: Record<string, string> = {};

    for (const dateStr of dateStrings) {
      const date = new Date(`${dateStr}T00:00:00.000Z`);
      const iso = dateStr;
      const staffRow = staffByDate.get(iso);
      const hasScan = scanDates.has(iso);

      const teacherPresent =
        staffRow?.status === StaffAttendanceStatus.PRESENT ||
        staffRow?.status === StaffAttendanceStatus.LATE ||
        staffRow?.status === StaffAttendanceStatus.HALF_DAY ||
        staffRow?.check_in_at != null ||
        hasScan ||
        (staffRow?.status === StaffAttendanceStatus.EXCUSED &&
          (staffRow.source === AttendanceSource.SYSTEM ||
            staffRow.notes?.includes('Makeup class held')));

      for (const slot of slots) {
        if (slot.day_of_week !== date.getUTCDay()) continue;

        const cellKey = `${slot.id}_${iso}`;
        const slotRoll = rollBySlotKey.get(cellKey) ?? rollByBlockKey.get(`${slot.block_number}_${iso}`);
        const rollSubmitted = slotRoll?.status === 'SUBMITTED';

        const [startYear] = slot.timetables.academic_year.split('-').map(Number);
        const academicStart = new Date(Date.UTC(startYear, 7, 1)); // August 1

        if (date.getTime() < academicStart.getTime() && !rollSubmitted) {
          statuses[cellKey] = 'offDay';
          continue;
        }

        if (date.getTime() > today.getTime()) {
          statuses[cellKey] = 'upcoming';
          continue;
        }

        const sourceReschedule = sourceRescheduleByKey.get(cellKey);
        if (sourceReschedule) {
          if (sourceReschedule.status === 'COMPLETED') {
            statuses[cellKey] = 'excused';
            continue;
          }
          if (rollSubmitted || teacherPresent) {
            statuses[cellKey] = 'conducted';
          } else {
            statuses[cellKey] = 'rescheduled';
          }
          continue;
        }

        const makeupReschedule = makeupRescheduleByKey.get(cellKey);
        if (makeupReschedule) {
          if (makeupReschedule.status === 'COMPLETED') {
            statuses[cellKey] = 'makeupClass';
            continue;
          }
          if (date.getTime() > today.getTime()) {
            statuses[cellKey] = 'makeupClass';
          } else if (rollSubmitted || teacherPresent) {
            statuses[cellKey] = 'makeupClass';
          } else {
            statuses[cellKey] = 'notConducted';
          }
          continue;
        }

        // Standard past/today lesson slot
        if (rollSubmitted || teacherPresent) {
          statuses[cellKey] = 'conducted';
        } else {
          statuses[cellKey] = 'notConducted';
        }
      }
    }

    return createApiResponse({ statuses }, HttpStatus.OK, 'Week statuses retrieved');
  }
}

