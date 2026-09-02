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

@ApiTags('Attendance Roll Sessions')
@ApiBearerAuth()
@Controller('attendance/roll-sessions')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class RollSessionsController {
  constructor(private readonly rollSessionsService: RollSessionsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  async findAll(
    @Query() query: ListRollSessionsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.rollSessionsService.findAll(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Roll sessions retrieved successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.rollSessionsService.findOne(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Roll session retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
  async create(
    @Body() dto: CreateRollSessionDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.rollSessionsService.create(dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Roll session created successfully');
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRollSessionDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const canEditLocked =
      user.role === 'SUPER_ADMIN' ||
      (user.permissions ?? []).includes('attendance.student.edit_locked');
    const data = await this.rollSessionsService.update(id, dto, user, canEditLocked);
    return createApiResponse(data, HttpStatus.OK, 'Roll session updated successfully');
  }

  @Post(':id/skip')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
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
  async revert(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.rollSessionsService.revert(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Roll session reverted to draft');
  }
}
