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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { createApiResponse } from '../../utils/serializer.util';
import { SubjectsService } from './subjects.service';
import {
  CreateSubjectDto,
  ListSubjectsQueryDto,
  UpdateSubjectDto,
} from './dto/timetables.dto';

@ApiTags('Subjects')
@ApiBearerAuth()
@Controller('subjects')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class SubjectsController {
  constructor(private readonly service: SubjectsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Timetable'))
  async list(@Query() query: ListSubjectsQueryDto) {
    const data = await this.service.list(query);
    return createApiResponse(data, HttpStatus.OK, 'Subjects retrieved');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async create(@Body() dto: CreateSubjectDto) {
    const data = await this.service.create(dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Subject created');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSubjectDto,
  ) {
    const data = await this.service.update(id, dto);
    return createApiResponse(data, HttpStatus.OK, 'Subject updated');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async remove(@Param('id', ParseIntPipe) id: number) {
    const data = await this.service.remove(id);
    return createApiResponse(data, HttpStatus.OK, 'Subject deleted');
  }
}
