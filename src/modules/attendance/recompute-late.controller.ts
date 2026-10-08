import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsISO8601 } from 'class-validator';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { ScopeService } from '../../common/scope/scope.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { createApiResponse } from '../../utils/serializer.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { ZkAttendanceProcessorService } from './zk-attendance-processor.service';
import { AttendancePolicyResolverService } from './attendance-policy-resolver.service';
import { HolidayAttendanceSyncService } from '../hr/calendar/holiday-attendance-sync.service';
import { AttendanceSource, DevicePersonType, Prisma } from '@prisma/client';

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

  /** Who to recompute. Defaults to everyone (or students only when class_id is set). */
  @IsOptional()
  @IsIn(['ALL', 'STAFF', 'STUDENTS'])
  target?: 'ALL' | 'STAFF' | 'STUDENTS';

  /** Staff filter — setting it makes the run staff-only. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  department_id?: number;

  /** Staff filter — setting it makes the run staff-only. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  staff_category_id?: number;

  /** Staff filter — setting it makes the run staff-only. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  segment_id?: number;

  /** One employee only — makes the run staff-only. Must belong to campus_id. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employee_id?: number;

  /**
   * Deliberate override: recompute staff expected check-in/out from the
   * CURRENT timetable/policy state, overwriting any existing snapshot.
   * Omit (default false) for routine reprocessing — that path reuses each
   * day's already-snapshotted expected times so a timetable edit made since
   * can't silently change historical late/absent status.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

@ApiTags('Attendance Recompute')
@ApiBearerAuth()
@Controller('attendance')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class RecomputeLateController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: ZkAttendanceProcessorService,
    private readonly scope: ScopeService,
    private readonly policyResolver: AttendancePolicyResolverService,
    private readonly holidaySync: HolidayAttendanceSyncService,
  ) {}

  // Called only by the Attendance Settings page. It rewrites attendance for a
  // whole campus, so the campus (and class, when given) must be inside the
  // caller's scope: this route had no scope check at all.
  @Post('recompute-late-status')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#recompute')
  async recomputeLateStatus(@Body() dto: RecomputeLateStatusDto, @CurrentUser() user: IJwtStaffPayload) {
    this.scope.assertCampus(user, dto.campus_id);
    if (user.campusId != null && dto.campus_id !== user.campusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }
    if (dto.class_id != null) this.scope.assertClass(user, dto.class_id);
    if (dto.department_id != null) this.scope.assertDepartment(user, dto.department_id);
    if (dto.staff_category_id != null) this.scope.assertStaffCategory(user, dto.staff_category_id);
    if (dto.segment_id != null) this.scope.assertSegment(user, dto.segment_id);

    // A class narrows to students; a department/category narrows to staff.
    if (dto.employee_id != null) {
      const employee = await this.prisma.employee_profiles.findUnique({
        where: { id: dto.employee_id },
        select: { campus_id: true, segment_id: true, department_id: true, staff_category_id: true },
      });
      if (!employee) throw new BadRequestException('Employee not found');
      this.scope.assertEmployee(user, employee);
      if (employee.campus_id !== dto.campus_id) {
        throw new BadRequestException("The selected campus is not this employee's campus.");
      }
    }
    const hasStaffFilter =
      dto.department_id != null || dto.staff_category_id != null || dto.segment_id != null || dto.employee_id != null;
    if (hasStaffFilter && (dto.class_id != null || dto.target === 'STUDENTS')) {
      throw new BadRequestException('Employee, department and staff category filters apply to staff — remove the class / students-only selection.');
    }
    if (dto.class_id != null && dto.target === 'STAFF') {
      throw new BadRequestException('A class filter applies to students — remove it for a staff-only recompute.');
    }
    const includeStaff = dto.target !== 'STUDENTS' && dto.class_id == null;
    const includeStudents = dto.target !== 'STAFF' && !hasStaffFilter;
    const employeeWhere: Prisma.employee_profilesWhereInput = {
      ...(dto.department_id != null ? { department_id: dto.department_id } : {}),
      ...(dto.staff_category_id != null ? { staff_category_id: dto.staff_category_id } : {}),
      ...(dto.segment_id != null ? { segment_id: dto.segment_id } : {}),
      ...(dto.employee_id != null ? { id: dto.employee_id } : {}),
    };
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

    // 0. Re-sync day-off rows against the CURRENT calendar and schedules.
    // SYSTEM "EXCUSED – Weekend/Holiday" rows are written once and never
    // revisited, and upsert*Daily deliberately won't overwrite them — so after
    // e.g. a 5-day employee is corrected to 6 days, their past Saturdays stayed
    // EXCUSED even with punches on them. The sync deletes SYSTEM rows for days
    // that now resolve as working (and adds them for days that became off),
    // leaving MANUAL/LEAVE rows alone; the recompute below then rebuilds those
    // days from the scans.
    let staleDayOffCleared = 0;
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86_400_000)) {
      const synced = await this.holidaySync.syncCampusForDate(dto.campus_id, d, {
        skipStudents: !includeStudents,
        skipStaff: !includeStaff,
        employeeWhere,
      });
      staleDayOffCleared += synced.cleared_staff + synced.cleared_students;
    }

    // 1. Recompute Students
    // Query active student scans and existing student daily biometric records in the date range
    const studentScans = !includeStudents ? [] : await this.prisma.zk_attendance_scans.findMany({
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

    const studentDailyRows = !includeStudents ? [] : await this.prisma.attendance_student_daily.findMany({
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

    // Memoized for the run: resolving a student's punch direction needs their
    // campus+class pairing, which upsertStudentDaily then resolves again for
    // the expected check-in. Over a date range that is several redundant reads
    // per student-day against a remote database. Scoped and released below.
    let studentsRecomputed = 0;
    this.processor.beginBatch();
    this.policyResolver.beginBatch();
    try {
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
    } finally {
      this.processor.endBatch();
      this.policyResolver.endBatch();
    }

    // 2. Recompute Staff (only if class_id is not specified)
    let staffRecomputed = 0;
    if (includeStaff) {
      const staffScans = await this.prisma.zk_attendance_scans.findMany({
        where: {
          person_type: DevicePersonType.STAFF,
          attendance_date: { gte: start, lte: end },
          is_duplicate: false,
          employee_profiles: {
            ...employeeWhere,
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
          ...(hasStaffFilter ? { employee_profiles: employeeWhere } : {}),
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
        await this.processor.upsertStaffDaily(task.employeeId, task.date, seg, dto.force ?? false);
        staffRecomputed++;
      }
    }

    return createApiResponse(
      { studentsRecomputed, staffRecomputed, staleDayOffCleared },
      HttpStatus.OK,
      'Recomputation of late status completed successfully',
    );
  }
}
