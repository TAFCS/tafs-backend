import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsISO8601 } from 'class-validator';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { createApiResponse } from '../../utils/serializer.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { ZkAttendanceProcessorService } from './zk-attendance-processor.service';
import { AttendanceSource, DevicePersonType } from '@prisma/client';

export class RecomputeLateStatusDto {
  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @IsISO8601()
  date_from: string;

  @IsISO8601()
  date_to: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  class_id?: number;
}

@ApiTags('Attendance Recompute')
@ApiBearerAuth()
@Controller('attendance')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class RecomputeLateController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: ZkAttendanceProcessorService,
  ) {}

  @Post('recompute-late-status')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async recomputeLateStatus(@Body() dto: RecomputeLateStatusDto) {
    const fromDate = new Date(dto.date_from);
    const toDate = new Date(dto.date_to);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestException('Invalid date format');
    }

    if (fromDate > toDate) {
      throw new BadRequestException('date_from must be less than or equal to date_to');
    }

    // Set dates to start of UTC day for proper matching
    const start = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()));
    const end = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate()));

    // 1. Recompute Students
    // Query active student scans and existing student daily biometric records in the date range
    const studentScans = await this.prisma.zk_attendance_scans.findMany({
      where: {
        person_type: DevicePersonType.STUDENT,
        attendance_date: { gte: start, lte: end },
        is_duplicate: false,
        students: {
          campus_id: dto.campus_id,
          ...(dto.class_id ? { class_id: dto.class_id } : {}),
        },
      },
      select: {
        student_cc: true,
        attendance_date: true,
      },
    });

    const studentDailyRows = await this.prisma.attendance_student_daily.findMany({
      where: {
        campus_id: dto.campus_id,
        date: { gte: start, lte: end },
        source: AttendanceSource.BIOMETRIC,
        students: dto.class_id ? { class_id: dto.class_id } : undefined,
      },
      select: {
        student_cc: true,
        date: true,
      },
    });

    // Create unique key list to process
    const studentTasks = new Map<string, { studentCc: number; date: Date }>();
    for (const row of studentScans) {
      if (row.student_cc) {
        const key = `${row.student_cc}_${row.attendance_date.toISOString()}`;
        studentTasks.set(key, { studentCc: row.student_cc, date: row.attendance_date });
      }
    }
    for (const row of studentDailyRows) {
      const key = `${row.student_cc}_${row.date.toISOString()}`;
      studentTasks.set(key, { studentCc: row.student_cc, date: row.date });
    }

    let studentsRecomputed = 0;
    for (const task of studentTasks.values()) {
      const seg = await this.processor.recomputeDaySequence(
        DevicePersonType.STUDENT,
        null,
        task.studentCc,
        task.date,
      );
      await this.processor.upsertStudentDaily(task.studentCc, task.date, seg);
      studentsRecomputed++;
    }

    // 2. Recompute Staff (only if class_id is not specified)
    let staffRecomputed = 0;
    if (!dto.class_id) {
      const staffScans = await this.prisma.zk_attendance_scans.findMany({
        where: {
          person_type: DevicePersonType.STAFF,
          attendance_date: { gte: start, lte: end },
          is_duplicate: false,
          employee_profiles: {
            campus_id: dto.campus_id,
          },
        },
        select: {
          employee_id: true,
          attendance_date: true,
        },
      });

      const staffDailyRows = await this.prisma.attendance_staff_daily.findMany({
        where: {
          campus_id: dto.campus_id,
          date: { gte: start, lte: end },
          source: AttendanceSource.BIOMETRIC,
        },
        select: {
          employee_id: true,
          date: true,
        },
      });

      const staffTasks = new Map<string, { employeeId: number; date: Date }>();
      for (const row of staffScans) {
        if (row.employee_id) {
          const key = `${row.employee_id}_${row.attendance_date.toISOString()}`;
          staffTasks.set(key, { employeeId: row.employee_id, date: row.attendance_date });
        }
      }
      for (const row of staffDailyRows) {
        const key = `${row.employee_id}_${row.date.toISOString()}`;
        staffTasks.set(key, { employeeId: row.employee_id, date: row.date });
      }

      for (const task of staffTasks.values()) {
        const seg = await this.processor.recomputeDaySequence(
          DevicePersonType.STAFF,
          task.employeeId,
          null,
          task.date,
        );
        await this.processor.upsertStaffDaily(task.employeeId, task.date, seg);
        staffRecomputed++;
      }
    }

    return createApiResponse(
      { studentsRecomputed, staffRecomputed },
      HttpStatus.OK,
      'Recomputation of late status completed successfully',
    );
  }
}
