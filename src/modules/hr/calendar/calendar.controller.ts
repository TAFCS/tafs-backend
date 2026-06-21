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
  ForbiddenException,
  Req,
} from '@nestjs/common';
import { CalendarService, CreateCalendarDayDto, SyncCalendarAttendanceDto } from './calendar.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';
import { StaffRole } from '@prisma/client';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';

@ApiTags('HR Calendar')
@ApiBearerAuth()
@Controller('hr/calendar')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  private assertSuperAdmin(user: IJwtStaffPayload) {
    if (user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can manage the academic calendar');
    }
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Calendar'))
  async findAll(@Query('campusId') campusId: string, @Query('appliesTo') appliesTo?: string) {
    const data = await this.calendarService.findAll(parseInt(campusId, 10), appliesTo);
    return createApiResponse(data, HttpStatus.OK, 'Calendar days retrieved successfully');
  }

  @Post('sync-attendance')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  async syncAttendance(
    @Body() dto: SyncCalendarAttendanceDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    this.assertSuperAdmin(req.user);
    const data = await this.calendarService.syncAttendance(dto);
    return createApiResponse(data, HttpStatus.OK, 'Holiday attendance synced successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Calendar'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const data = await this.calendarService.findOne(id);
    return createApiResponse(data, HttpStatus.OK, 'Calendar day retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  async create(@Body() dto: CreateCalendarDayDto, @Req() req: { user: IJwtStaffPayload }) {
    this.assertSuperAdmin(req.user);
    const data = await this.calendarService.create(dto, req.user.sub);
    return createApiResponse(data, HttpStatus.CREATED, 'Calendar day created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateCalendarDayDto>,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    this.assertSuperAdmin(req.user);
    const data = await this.calendarService.update(id, dto);
    return createApiResponse(data, HttpStatus.OK, 'Calendar day updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: { user: IJwtStaffPayload }) {
    this.assertSuperAdmin(req.user);
    const data = await this.calendarService.remove(id);
    return createApiResponse(data, HttpStatus.OK, 'Calendar day deleted successfully');
  }
}
