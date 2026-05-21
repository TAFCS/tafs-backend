import { Body, Controller, Get, HttpStatus, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { Action } from '../auth/casl/actions';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { StaffAttendanceService } from './staff-attendance.service';
import { BulkMarkStaffAttendanceDto, GetStaffAttendanceQueryDto } from './dto/staff-attendance.dto';

@ApiTags('Attendance Staff')
@ApiBearerAuth()
@Controller('attendance/staff')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class StaffAttendanceController {
  constructor(private readonly staffAttendanceService: StaffAttendanceService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async getRegister(
    @Query() query: GetStaffAttendanceQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.staffAttendanceService.getRegister(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff attendance register retrieved');
  }

  @Put()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'StaffAttendance'))
  async bulkMark(
    @Body() dto: BulkMarkStaffAttendanceDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.staffAttendanceService.bulkMark(dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff attendance saved');
  }
}
