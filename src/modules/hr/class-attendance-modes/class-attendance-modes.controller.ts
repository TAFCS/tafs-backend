import { Controller, Get, Post, Delete, Body, Param, ParseIntPipe, UseGuards, HttpStatus } from '@nestjs/common';
import { ClassAttendanceModesService, SetClassAttendanceModeDto } from './class-attendance-modes.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';

@ApiTags('Class Attendance Modes')
@ApiBearerAuth()
@Controller('hr/class-attendance-modes')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class ClassAttendanceModesController {
  constructor(private readonly modesService: ClassAttendanceModesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'ClassAttendanceMode'))
  async findAll() {
    const data = await this.modesService.findAll();
    return createApiResponse(data, HttpStatus.OK, 'Class attendance modes retrieved successfully');
  }

  @Get(':classId')
  @CheckPolicies((ability) => ability.can(Action.Read, 'ClassAttendanceMode'))
  async findOne(@Param('classId', ParseIntPipe) classId: number) {
    const data = await this.modesService.findOneByClass(classId);
    return createApiResponse(data, HttpStatus.OK, 'Class attendance mode retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'ClassAttendanceMode'))
  async setMode(@Body() dto: SetClassAttendanceModeDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.modesService.setMode(dto, user.username);
    return createApiResponse(data, HttpStatus.OK, 'Class attendance mode set successfully');
  }

  @Delete(':classId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'ClassAttendanceMode'))
  async remove(@Param('classId', ParseIntPipe) classId: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.modesService.remove(classId, user.username);
    return createApiResponse(data, HttpStatus.OK, 'Class attendance mode configuration removed successfully');
  }
}
