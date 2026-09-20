import { Controller, Get, Post, Delete, Body, Param, ParseIntPipe, UseGuards, HttpStatus } from '@nestjs/common';
import { ClassAttendanceModesService, SetClassAttendanceModeDto } from './class-attendance-modes.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';

// Class Modes: called only by the class-modes page.
@ApiTags('Class Attendance Modes')
@ApiBearerAuth()
@Controller('hr/class-attendance-modes')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class ClassAttendanceModesController {
  constructor(private readonly modesService: ClassAttendanceModesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'ClassAttendanceMode'))
  @RequireAction('attendance.class_modes#view')
  async findAll() {
    const data = await this.modesService.findAll();
    return createApiResponse(data, HttpStatus.OK, 'Class attendance modes retrieved successfully');
  }

  @Get(':classId')
  @CheckPolicies((ability) => ability.can(Action.Read, 'ClassAttendanceMode'))
  @RequireAction('attendance.class_modes#view')
  async findOne(@Param('classId', ParseIntPipe) classId: number) {
    const data = await this.modesService.findOneByClass(classId);
    return createApiResponse(data, HttpStatus.OK, 'Class attendance mode retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'ClassAttendanceMode'))
  @RequireAction('attendance.class_modes#manage')
  async setMode(@Body() dto: SetClassAttendanceModeDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.modesService.setMode(dto, user.username);
    return createApiResponse(data, HttpStatus.OK, 'Class attendance mode set successfully');
  }

  @Delete(':classId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'ClassAttendanceMode'))
  @RequireAction('attendance.class_modes#manage')
  async remove(@Param('classId', ParseIntPipe) classId: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.modesService.remove(classId, user.username);
    return createApiResponse(data, HttpStatus.OK, 'Class attendance mode configuration removed successfully');
  }
}
