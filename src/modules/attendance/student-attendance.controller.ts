import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { Action } from '../auth/casl/actions';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { StudentAttendanceService } from './student-attendance.service';
import {
  GetStudentAttendanceQueryDto,
  GetStudentTimelineQueryDto,
  ResolveStudentAttendanceDto,
} from './dto/student-attendance.dto';

@ApiTags('Attendance Students')
@ApiBearerAuth()
@Controller('attendance/students')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class StudentAttendanceController {
  constructor(private readonly studentAttendanceService: StudentAttendanceService) {}

  @Get('summary')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  async getSummary(
    @Query() query: GetStudentAttendanceQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.getSummary(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Student attendance summary retrieved');
  }

  @Get('dashboard')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  async getDashboard(
    @Query() query: GetStudentAttendanceQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.getDashboard(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Student attendance dashboard retrieved');
  }

  @Get(':studentCc/timeline')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  async getTimeline(
    @Param('studentCc', ParseIntPipe) studentCc: number,
    @Query() query: GetStudentTimelineQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.getTimeline(studentCc, query, user);
    return createApiResponse(data, HttpStatus.OK, 'Student attendance timeline retrieved');
  }

  @Put(':studentCc/resolve')
  @CheckPolicies((ability) => ability.can(Action.Update, 'RollSession'))
  async resolveAttendance(
    @Param('studentCc', ParseIntPipe) studentCc: number,
    @Body() dto: ResolveStudentAttendanceDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.studentAttendanceService.resolveAttendance(studentCc, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Student attendance resolved');
  }
}
