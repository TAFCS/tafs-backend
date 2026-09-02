import {
  Body,
  Controller,
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
import { StaffLessonReschedulesService } from './staff-lesson-reschedules.service';
import {
  CreateStaffLessonRescheduleDto,
  ListStaffLessonReschedulesQueryDto,
  ListStaffLessonTeachersQueryDto,
  StaffLessonSourceDateStatusQueryDto,
  TeacherHoldStatusQueryDto,
  TeacherSlotsQueryDto,
} from './dto/staff-lesson-reschedules.dto';

@ApiTags('Staff Lesson Reschedules')
@ApiBearerAuth()
@Controller('attendance/staff-lesson-reschedules')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class StaffLessonReschedulesController {
  constructor(private readonly service: StaffLessonReschedulesService) {}

  @Get('teachers')
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async listTeachers(
    @Query() query: ListStaffLessonTeachersQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.listTeachers(query, user);
    return createApiResponse(data, HttpStatus.OK, 'O-Level timetable teachers retrieved');
  }

  @Get('teachers/:employeeId/hold-status')
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async teacherHoldStatus(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Query() query: TeacherHoldStatusQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.getTeacherHoldStatus(employeeId, query, user);
    return createApiResponse(data, HttpStatus.OK, 'Teacher slot hold status retrieved');
  }

  @Get('teachers/:employeeId/slots')
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async teacherSlots(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Query() query: TeacherSlotsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.getTeacherSlots(employeeId, query, user);
    return createApiResponse(data, HttpStatus.OK, 'Teacher O-Level slots retrieved');
  }

  @Get('source-date-status')
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async sourceDateStatus(
    @Query() query: StaffLessonSourceDateStatusQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.getSourceDateStatus(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Source date staff status retrieved');
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async findAll(
    @Query() query: ListStaffLessonReschedulesQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.findAll(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff lesson reschedules retrieved');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.findOne(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff lesson reschedule retrieved');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'StaffAttendance'))
  async create(
    @Body() dto: CreateStaffLessonRescheduleDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.create(dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Staff lesson reschedule created');
  }

  @Post(':id/complete')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'StaffAttendance'))
  async complete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.complete(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Makeup confirmed — staff register updated');
  }

  @Post(':id/cancel')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'StaffAttendance'))
  async cancel(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.cancel(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff lesson reschedule cancelled');
  }

  @Post(':id/reverse')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'StaffAttendance'))
  async reverse(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.reverse(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Staff lesson reschedule reversed');
  }
}
