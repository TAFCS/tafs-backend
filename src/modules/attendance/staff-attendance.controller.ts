import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { Action } from '../auth/casl/actions';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { StaffAttendanceService } from './staff-attendance.service';
import {
  BulkMarkStaffAttendanceDto,
  GetStaffAttendanceQueryDto,
  GetStaffTimelineQueryDto,
  GetMyStaffAttendanceQueryDto,
} from './dto/staff-attendance.dto';

@ApiTags('Attendance Staff')
@ApiBearerAuth()
@Controller('attendance/staff')
@UseGuards(JwtStaffGuard)
export class StaffAttendanceController {
  constructor(private readonly staffAttendanceService: StaffAttendanceService) {}

  @Get()
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async getRegister(
    @Query() query: GetStaffAttendanceQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.staffAttendanceService.getRegister(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff attendance register retrieved');
  }

  @Put()
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'StaffAttendance'))
  async bulkMark(
    @Body() dto: BulkMarkStaffAttendanceDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.staffAttendanceService.bulkMark(dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff attendance saved');
  }

  @Get('summary')
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async getSummary(
    @Query() query: GetStaffAttendanceQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.staffAttendanceService.getSummary(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff attendance summary retrieved');
  }

  @Get('dashboard')
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async getDashboard(
    @Query() query: GetStaffAttendanceQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.staffAttendanceService.getDashboard(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff attendance dashboard retrieved');
  }

  @Get('me')
  async getMyAttendance(
    @Query() query: GetMyStaffAttendanceQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.staffAttendanceService.getMyAttendance(user.sub, query);
    return createApiResponse(data, HttpStatus.OK, 'My attendance retrieved');
  }

  @Get(':employeeId/timeline')
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async getTimeline(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Query() query: GetStaffTimelineQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.staffAttendanceService.getTimeline(employeeId, query, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff attendance timeline retrieved');
  }
}
