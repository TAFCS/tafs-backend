import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
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
import { assertStaffSelfPermission, ATTENDANCE_SELF_VIEW } from '../../common/staff-self-service.util';
import { AttendanceObjectionsService } from './attendance-objections.service';
import {
  CreateAttendanceObjectionDto,
  ListAttendanceObjectionsQueryDto,
  ReviewAttendanceObjectionDto,
} from './dto/attendance-objections.dto';

@ApiTags('Attendance Objections')
@ApiBearerAuth()
@Controller('attendance/objections')
@UseGuards(JwtStaffGuard)
export class AttendanceObjectionsController {
  constructor(private readonly objectionsService: AttendanceObjectionsService) {}

  @Post()
  async create(
    @CurrentUser() user: IJwtStaffPayload,
    @Body() dto: CreateAttendanceObjectionDto,
  ) {
    assertStaffSelfPermission(user, ATTENDANCE_SELF_VIEW);
    const data = await this.objectionsService.create(user.sub, dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Objection submitted successfully');
  }

  @Get('me')
  async listMine(@CurrentUser() user: IJwtStaffPayload) {
    assertStaffSelfPermission(user, ATTENDANCE_SELF_VIEW);
    const data = await this.objectionsService.listMine(user.sub);
    return createApiResponse(data, HttpStatus.OK, 'Objections retrieved successfully');
  }

  @Get()
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'StaffAttendance'))
  async listForReview(
    @Query() query: ListAttendanceObjectionsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.objectionsService.listForReview(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Objections retrieved successfully');
  }

  @Patch(':id')
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'StaffAttendance'))
  async review(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewAttendanceObjectionDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.objectionsService.review(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Objection reviewed successfully');
  }
}
