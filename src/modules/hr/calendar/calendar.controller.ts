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
import {
  CalendarService,
  CreateCalendarDayDto,
  CreateBulkCalendarDayDto,
  CreateEmployeeCalendarDaysDto,
  SyncCalendarAttendanceDto,
} from './calendar.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';
import { StaffRole } from '@prisma/client';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { auditActorLabel } from '../../../common/utils/audit-actor.util';

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

  @Post('bulk')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  async createBulk(
    @Body() dto: CreateBulkCalendarDayDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    this.assertSuperAdmin(req.user);
    const data = await this.calendarService.createBulk(dto, req.user.sub, auditActorLabel(req.user));
    return createApiResponse(data, HttpStatus.CREATED, 'Calendar days created for all campuses');
  }

  @Post('bulk-employees')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  async createForEmployees(
    @Body() dto: CreateEmployeeCalendarDaysDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    this.assertSuperAdmin(req.user);
    const data = await this.calendarService.createForEmployees(dto, req.user.sub, auditActorLabel(req.user));
    return createApiResponse(data, HttpStatus.CREATED, 'Calendar overrides created for selected employees');
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
    const data = await this.calendarService.create(dto, req.user.sub, auditActorLabel(req.user));
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
    const data = await this.calendarService.update(id, dto, auditActorLabel(req.user));
    return createApiResponse(data, HttpStatus.OK, 'Calendar day updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Calendar'))
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: { user: IJwtStaffPayload }) {
    this.assertSuperAdmin(req.user);
    const data = await this.calendarService.remove(id, auditActorLabel(req.user));
    return createApiResponse(data, HttpStatus.OK, 'Calendar day deleted successfully');
  }
}
