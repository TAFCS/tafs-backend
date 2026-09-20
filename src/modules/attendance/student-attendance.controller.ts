import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { Action } from '../auth/casl/actions';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { StudentAttendanceService } from './student-attendance.service';
import {
  GetStudentAttendanceQueryDto,
  GetStudentAttendanceMatrixQueryDto,
  BulkManualStudentAttendanceDto,
  GetStudentTimelineQueryDto,
  ManualStudentScanDto,
  ResolveStudentAttendanceDto,
} from './dto/student-attendance.dto';

// Route-shaped across three tiles: the Student Attendance page (summary, dashboard,
// timeline, bulk mark, resolve), the Student Attendance by Cycle page (matrix and
// its export) and the Quick Check-In page (state and scan). Each route is called
// by exactly one of them. The policy check is unchanged and ANDed with the tile
// action; scope was already enforced by the earlier scope sweep.
@ApiTags('Attendance Students')
@ApiBearerAuth()
@Controller('attendance/students')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class StudentAttendanceController {
  constructor(private readonly studentAttendanceService: StudentAttendanceService) {}

  @Get('summary')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  @RequireAction('attendance.student_attendance#view')
  async getSummary(
    @Query() query: GetStudentAttendanceQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.getSummary(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Student attendance summary retrieved');
  }

  @Get('dashboard')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  @RequireAction('attendance.student_attendance#view')
  async getDashboard(
    @Query() query: GetStudentAttendanceQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.getDashboard(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Student attendance dashboard retrieved');
  }

  /** Payroll-cycle-independent lines + punch matrix, mirroring HR payroll's attendance-matrix. Registered before `:studentCc/*` so it isn't swallowed by that param route. */
  @Get('matrix')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  @RequireAction('attendance.student_attendance_cycle#view')
  async getAttendanceMatrix(
    @Query() query: GetStudentAttendanceMatrixQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.getAttendanceMatrix(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Student attendance matrix retrieved successfully');
  }

  @Get('matrix/export')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  @RequireAction('attendance.student_attendance_cycle#export')
  async exportAttendanceMatrix(
    @Query() query: GetStudentAttendanceMatrixQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
    @Res() res: Response,
  ) {
    const buffer = await this.studentAttendanceService.exportAttendanceMatrix(query, user);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="student-attendance-${query.period_start}-to-${query.period_end}.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  @Get(':studentCc/timeline')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  @RequireAction('attendance.student_attendance#view')
  async getTimeline(
    @Param('studentCc', ParseIntPipe) studentCc: number,
    @Query() query: GetStudentTimelineQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.getTimeline(studentCc, query, user);
    return createApiResponse(data, HttpStatus.OK, 'Student attendance timeline retrieved');
  }

  /** Gate-desk panel: today's punch state for one student. */
  @Get(':studentCc/quick-check')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  @RequireAction('attendance.quick_check_in#view')
  async getQuickCheckState(
    @Param('studentCc', ParseIntPipe) studentCc: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.getQuickCheckState(studentCc, user);
    return createApiResponse(data, HttpStatus.OK, 'Student check-in state retrieved');
  }

  /** Gate-desk panel: record a check-in or check-out at the current time. */
  @Post(':studentCc/quick-check')
  @CheckPolicies((ability) => ability.can(Action.Update, 'RollSession'))
  @RequireAction('attendance.quick_check_in#scan')
  async manualScan(
    @Param('studentCc', ParseIntPipe) studentCc: number,
    @Body() dto: ManualStudentScanDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.manualScan(studentCc, dto, user);
    return createApiResponse(
      data,
      HttpStatus.CREATED,
      data.direction === 'IN' ? 'Student checked in' : 'Student checked out',
    );
  }

  @Put(':studentCc/resolve')
  @CheckPolicies((ability) => ability.can(Action.Update, 'RollSession'))
  @RequireAction('attendance.student_attendance#resolve')
  async resolveAttendance(
    @Param('studentCc', ParseIntPipe) studentCc: number,
    @Body() dto: ResolveStudentAttendanceDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.resolveAttendance(studentCc, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Student attendance resolved');
  }

  @Put('bulk-manual')
  @CheckPolicies((ability) => ability.can(Action.Update, 'RollSession'))
  @RequireAction('attendance.student_attendance#mark')
  async bulkManualMark(
    @Body() dto: BulkManualStudentAttendanceDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.bulkManualMark(dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Student attendance marked');
  }
}
