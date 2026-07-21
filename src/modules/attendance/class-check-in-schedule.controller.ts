import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Query,
  Param,
  ParseIntPipe,
  UseGuards,
  HttpStatus,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { createApiResponse } from '../../utils/serializer.util';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
  ClassCheckInScheduleService,
  CreateClassScheduleDto,
  UpdateClassScheduleDto,
} from './class-check-in-schedule.service';

@ApiTags('Class Check-In Schedules')
@ApiBearerAuth()
@Controller('hr/class-check-in-schedules')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class ClassCheckInScheduleController {
  constructor(private readonly service: ClassCheckInScheduleService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Policy'))
  async findAll(@Query('campus_id') campusId: string) {
    if (!campusId) {
      throw new BadRequestException('campus_id is required');
    }
    const data = await this.service.findAll(parseInt(campusId, 10));
    return createApiResponse(data, HttpStatus.OK, 'Class schedules retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async create(@Body() dto: CreateClassScheduleDto, @Req() req: { user: IJwtStaffPayload }) {
    const data = await this.service.create(dto, req.user.sub);
    return createApiResponse(data, HttpStatus.CREATED, 'Class schedule created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateClassScheduleDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.update(id, dto, req.user.username || req.user.sub);
    return createApiResponse(data, HttpStatus.OK, 'Class schedule updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.remove(id, req.user.username || req.user.sub);
    return createApiResponse(data, HttpStatus.OK, 'Class schedule deleted successfully');
  }
}
