import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction, RequireAnyAction } from '../../decorators/require-action.decorator';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { Action } from '../auth/casl/actions';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { RollSessionsService } from './roll-sessions.service';
import {
  CreateRollSessionDto,
  ListRollSessionsQueryDto,
  SkipRollSessionDto,
  UpdateRollSessionDto,
} from './dto/roll-sessions.dto';

// Roll sessions are used by the A-Level Roll Call page and by the roll-marking
// mode of the Timetables page (useSlotAttendanceSession), so list / open /
// create / update / revert accept either tile. `skip` is called only by the
// A-Level Roll Call page. The policy check stays ANDed, so a Timetables viewer
// still needs the roll-call capability to write.
@ApiTags('Attendance Roll Sessions')
@ApiBearerAuth()
@Controller('attendance/roll-sessions')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class RollSessionsController {
  constructor(private readonly rollSessionsService: RollSessionsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  @RequireAnyAction('attendance.alevel_roll_call#view', 'attendance.timetables#view')
  async findAll(
    @Query() query: ListRollSessionsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.rollSessionsService.findAll(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Roll sessions retrieved successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  @RequireAnyAction('attendance.alevel_roll_call#view', 'attendance.timetables#view')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.rollSessionsService.findOne(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Roll session retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
  @RequireAnyAction('attendance.alevel_roll_call#mark', 'attendance.timetables#view')
  async create(
    @Body() dto: CreateRollSessionDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.rollSessionsService.create(dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Roll session created successfully');
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
  @RequireAnyAction('attendance.alevel_roll_call#mark', 'attendance.timetables#view')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRollSessionDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    // Correcting a submitted roll call is treated as part of taking roll
    // call, not a privileged override — anyone who can mark it can fix it.
    const canEditLocked =
      user.role === 'SUPER_ADMIN' ||
      (user.permissions ?? []).includes('attendance.student.edit_locked') ||
      (user.permissions ?? []).includes('attendance.student.rollcall.mark');
    const data = await this.rollSessionsService.update(id, dto, user, canEditLocked);
    return createApiResponse(data, HttpStatus.OK, 'Roll session updated successfully');
  }

  @Post(':id/skip')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
  @RequireAction('attendance.alevel_roll_call#skip')
  async skip(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SkipRollSessionDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.rollSessionsService.skip(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Roll session marked as skipped');
  }

  @Post(':id/revert')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
  @RequireAnyAction('attendance.alevel_roll_call#mark', 'attendance.timetables#view')
  async revert(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.rollSessionsService.revert(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Roll session reverted to draft');
  }
}
