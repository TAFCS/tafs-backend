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
} from '@nestjs/common';
import {
  CalendarService,
  CreateCalendarDayDto,
  CreateBulkCalendarDayDto,
  CreateEmployeeCalendarDaysDto,
  SyncCalendarAttendanceDto,
} from './calendar.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { RequireAction, RequireAnyAction } from '../../../decorators/require-action.decorator';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { auditActorLabel } from '../../../common/utils/audit-actor.util';

// Academic Calendar. Every write here used to be locked to SUPER_ADMIN by a raw
// role check, so it could never be delegated. They now take
// `attendance.academic_calendar#manage`, which no role holds by default (the
// tile has no legacy bridge), so a SUPER_ADMIN still passes and grants it per
// role or person. `bulk-employees` and delete are ALSO called by
// ShiftHolidayOverridesPanel, but deliberately accept ONLY this action: those
// were SUPER_ADMIN-only too, and accepting the Shift Overrides or Employee
// Directory actions would hand them to people who could not do it before. Only
// the list route, which was never SUPER_ADMIN-only, is shared with them.
@ApiTags('HR Calendar')
@ApiBearerAuth()
@Controller('hr/calendar')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Calendar'))
  @RequireAnyAction('attendance.academic_calendar#view', 'attendance.shift_overrides#view', 'hr.employee_directory#shift_overrides.view')
  async findAll(
    @Query('campusId') campusId?: string,
    @Query('appliesTo') appliesTo?: string,
    @Query('employeeId') employeeId?: string,
  ) {
    const data = await this.calendarService.findAll(
      campusId ? parseInt(campusId, 10) : undefined,
      appliesTo,
      employeeId ? parseInt(employeeId, 10) : undefined,
    );
    return createApiResponse(data, HttpStatus.OK, 'Calendar days retrieved successfully');
  }

  @Get('notification-reports')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Calendar'))
  @RequireAction('attendance.academic_calendar#view')
  async listNotificationReports(
    @Query('campusId') campusId?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.calendarService.listNotificationReports(
      campusId ? parseInt(campusId, 10) : NaN,
      limit ? parseInt(limit, 10) : 50,
    );
    return createApiResponse(data, HttpStatus.OK, 'Calendar notification reports retrieved successfully');
  }

  @Post('sync-attendance')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  @RequireAction('attendance.academic_calendar#manage')
  async syncAttendance(
    @Body() dto: SyncCalendarAttendanceDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.calendarService.syncAttendance(dto);
    return createApiResponse(data, HttpStatus.OK, 'Holiday attendance synced successfully');
  }

  @Post('bulk')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  @RequireAction('attendance.academic_calendar#manage')
  async createBulk(
    @Body() dto: CreateBulkCalendarDayDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.calendarService.createBulk(dto, req.user.sub, auditActorLabel(req.user));
    return createApiResponse(data, HttpStatus.CREATED, 'Calendar days created for all campuses');
  }

  @Post('bulk-employees')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  @RequireAction('attendance.academic_calendar#manage')
  async createForEmployees(
    @Body() dto: CreateEmployeeCalendarDaysDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.calendarService.createForEmployees(dto, req.user.sub, auditActorLabel(req.user));
    return createApiResponse(data, HttpStatus.CREATED, 'Calendar overrides created for selected employees');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Calendar'))
  @RequireAction('attendance.academic_calendar#view')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const data = await this.calendarService.findOne(id);
    return createApiResponse(data, HttpStatus.OK, 'Calendar day retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  @RequireAction('attendance.academic_calendar#manage')
  async create(@Body() dto: CreateCalendarDayDto, @Req() req: { user: IJwtStaffPayload }) {
    const data = await this.calendarService.create(dto, req.user.sub, auditActorLabel(req.user));
    return createApiResponse(data, HttpStatus.CREATED, 'Calendar day created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  @RequireAction('attendance.academic_calendar#manage')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateCalendarDayDto>,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.calendarService.update(id, dto, auditActorLabel(req.user));
    return createApiResponse(data, HttpStatus.OK, 'Calendar day updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  @RequireAction('attendance.academic_calendar#manage')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: { user: IJwtStaffPayload }) {
    const data = await this.calendarService.remove(id, auditActorLabel(req.user));
    return createApiResponse(data, HttpStatus.OK, 'Calendar day deleted successfully');
  }
}
