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
import type { Request } from 'express';
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
  async create(@Body() dto: CreateSubjectDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const data = await this.service.create(dto, changedBy);
    return createApiResponse(data, HttpStatus.CREATED, 'Subject created');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSubjectDto,
    @Req() req: Request,
  ) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const data = await this.service.update(id, dto, changedBy);
    return createApiResponse(data, HttpStatus.OK, 'Subject updated');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const data = await this.service.remove(id, changedBy);
    return createApiResponse(data, HttpStatus.OK, 'Subject deleted');
  }
}
