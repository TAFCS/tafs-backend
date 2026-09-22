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
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { createApiResponse } from '../../utils/serializer.util';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import {
  ClassCheckInScheduleService,
  CreateClassScheduleDto,
  UpdateClassScheduleDto,
} from './class-check-in-schedule.service';

@ApiTags('Class Check-In Schedules')
@ApiBearerAuth()
// Called only by the Attendance Settings page. Policy check unchanged and ANDed
// with the tile action; every route is limited to the caller's campus and class
// scope.
@Controller('hr/class-check-in-schedules')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class ClassCheckInScheduleController {
  constructor(private readonly service: ClassCheckInScheduleService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Policy'))
  @RequireAction('attendance.settings#view')
  async findAll(@Query('campus_id') campusId: string, @Req() req: { user: IJwtStaffPayload }) {
    if (!campusId) {
      throw new BadRequestException('campus_id is required');
    }
    const data = await this.service.findAll(parseInt(campusId, 10), req.user);
    return createApiResponse(data, HttpStatus.OK, 'Class schedules retrieved successfully');
  }

  /**
   * The exact wording parents would get, without sending anything. The dialog
   * shows this beside the Notify toggle so nobody fires a push blind.
   */
  @Post('preview-notification')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#schedules.manage')
  async previewNotification(
    @Body()
    dto: {
      campus_id: number;
      class_id: number;
      expected_check_in: string;
      end_time?: string | null;
      effective_from: string;
    },
    @Req() req: { user: IJwtStaffPayload },
  ) {
    if (!dto?.campus_id || !dto?.class_id) {
      throw new BadRequestException('campus_id and class_id are required');
    }
    const data = await this.service.previewNotification(
      {
        campusId: dto.campus_id,
        classId: dto.class_id,
        expectedCheckIn: dto.expected_check_in,
        endTime: dto.end_time,
        effectiveFrom: dto.effective_from,
      },
      req.user,
    );
    return createApiResponse(data, HttpStatus.OK, 'Notification preview generated');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#schedules.manage')
  async create(@Body() dto: CreateClassScheduleDto, @Req() req: { user: IJwtStaffPayload }) {
    const data = await this.service.create(dto, req.user.sub, auditActorLabel(req.user), req.user);
    return createApiResponse(data, HttpStatus.CREATED, 'Class schedule created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#schedules.manage')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateClassScheduleDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.update(id, dto, auditActorLabel(req.user), req.user);
    return createApiResponse(data, HttpStatus.OK, 'Class schedule updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#schedules.manage')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.remove(id, auditActorLabel(req.user), req.user);
    return createApiResponse(data, HttpStatus.OK, 'Class schedule deleted successfully');
  }
}
