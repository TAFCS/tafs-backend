import { Controller, Get, Post, Patch, Delete, Body, Query, Param, ParseIntPipe, UseGuards, HttpStatus } from '@nestjs/common';
import { CalendarService, CreateCalendarDayDto } from './calendar.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';

@ApiTags('HR Calendar')
@ApiBearerAuth()
@Controller('hr/calendar')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Calendar'))
  async findAll(@Query('campusId') campusId: string) {
    const data = await this.calendarService.findAll(parseInt(campusId, 10));
    return createApiResponse(data, HttpStatus.OK, 'Calendar days retrieved successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Calendar'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const data = await this.calendarService.findOne(id);
    return createApiResponse(data, HttpStatus.OK, 'Calendar day retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  async create(@Body() dto: CreateCalendarDayDto) {
    const data = await this.calendarService.create(dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Calendar day created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateCalendarDayDto>) {
    const data = await this.calendarService.update(id, dto);
    return createApiResponse(data, HttpStatus.OK, 'Calendar day updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  async remove(@Param('id', ParseIntPipe) id: number) {
    const data = await this.calendarService.remove(id);
    return createApiResponse(data, HttpStatus.OK, 'Calendar day deleted successfully');
  }
}
