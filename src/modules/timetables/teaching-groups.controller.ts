import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { createApiResponse } from '../../utils/serializer.util';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { TeachingGroupsService } from './teaching-groups.service';
import {
  BulkEnrollDto,
  CreateTeachingGroupDto,
  ListTeachingGroupsQueryDto,
  UpdateTeachingGroupDto,
} from './dto/teaching-groups.dto';

@ApiTags('Teaching Groups')
@ApiBearerAuth()
@Controller('teaching-groups')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class TeachingGroupsController {
  constructor(private readonly service: TeachingGroupsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Timetable'))
  async list(
    @Query() query: ListTeachingGroupsQueryDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.list(
      query.campus_id,
      query.class_id,
      query.academic_year,
      req.user,
    );
    return createApiResponse(data, HttpStatus.OK, 'Teaching groups retrieved');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async create(
    @Body() dto: CreateTeachingGroupDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.create(dto, req.user);
    return createApiResponse(data, HttpStatus.CREATED, 'Teaching group created');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTeachingGroupDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.update(id, dto, req.user);
    return createApiResponse(data, HttpStatus.OK, 'Teaching group updated');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.remove(id, req.user);
    return createApiResponse(data, HttpStatus.OK, 'Teaching group removed');
  }

  @Get(':id/roster')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Timetable'))
  async getRoster(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.getRoster(id, req.user);
    return createApiResponse(data, HttpStatus.OK, 'Roster retrieved');
  }

  @Post(':id/enrollments')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async bulkEnroll(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: BulkEnrollDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.bulkEnroll(id, dto, req.user);
    return createApiResponse(data, HttpStatus.OK, 'Students enrolled');
  }

  @Delete(':id/enrollments/:studentId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async removeEnrollment(
    @Param('id', ParseIntPipe) id: number,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.removeEnrollment(id, studentId, req.user);
    return createApiResponse(data, HttpStatus.OK, 'Enrollment removed');
  }

  @Get('students/:studentId/subject-enrollments')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Timetable'))
  async listStudentSubjectEnrollments(
    @Param('studentId', ParseIntPipe) studentId: number,
  ) {
    const data = await this.service.listStudentSubjectEnrollments(studentId);
    return createApiResponse(data, HttpStatus.OK, 'Student subject enrollments retrieved');
  }
}
