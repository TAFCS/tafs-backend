import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
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
import { ClassSessionReschedulesService } from './class-session-reschedules.service';
import {
  CreateClassRescheduleDto,
  EligibleSlotsQueryDto,
  ListClassReschedulesQueryDto,
  SourceDateHoldStatusQueryDto,
  UpdateRescheduleMakeupDto,
} from './dto/class-session-reschedules.dto';

@ApiTags('Class Session Reschedules')
@ApiBearerAuth()
@Controller('attendance/class-reschedules')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class ClassSessionReschedulesController {
  constructor(private readonly service: ClassSessionReschedulesService) {}

  @Get('eligible-slots')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  async eligibleSlots(
    @Query() query: EligibleSlotsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.getEligibleSlots(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Eligible source slots retrieved');
  }

  @Get('source-date-hold-status')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  async sourceDateHoldStatus(
    @Query() query: SourceDateHoldStatusQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.getSourceDateHoldStatus(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Source date hold status retrieved');
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  async findAll(
    @Query() query: ListClassReschedulesQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.findAll(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Class reschedules retrieved');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'RollSession'))
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.findOne(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Class reschedule retrieved');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
  async create(
    @Body() dto: CreateClassRescheduleDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.create(dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Class reschedule created');
  }

  @Post(':id/cancel')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
  async cancel(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.cancel(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Class reschedule cancelled');
  }

  @Post(':id/update-makeup')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
  async updateMakeup(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRescheduleMakeupDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.updateMakeupDate(id, dto.makeup_date, user);
    return createApiResponse(data, HttpStatus.OK, 'Makeup date updated');
  }

  @Post(':id/reverse')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'RollSession'))
  async reverse(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const canEditLocked =
      user.role === 'SUPER_ADMIN' ||
      (user.permissions ?? []).includes('attendance.student.edit_locked');
    if (!canEditLocked) {
      throw new ForbiddenException(
        'Requires attendance.student.edit_locked permission to reverse a completed reschedule',
      );
    }
    const data = await this.service.reverse(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Class reschedule reversed');
  }
}
