import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { SegmentsService } from './segments.service';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';
import { SetCampusSegmentsDto } from './dto/set-campus-segments.dto';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';

@ApiTags('HR Segments')
@ApiBearerAuth()
@Controller('hr/segments')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class SegmentsController {
  constructor(private readonly segmentsService: SegmentsService) {}

  @Get()
  @CheckPolicies(
    (ability) => ability.can(Action.Read, 'Employee') || ability.can(Action.Read, 'Class'),
  )
  async findAll(@Query('campus_id') campusId?: string) {
    const parsedCampusId = campusId ? parseInt(campusId, 10) : undefined;
    const data = await this.segmentsService.findAll(
      isNaN(parsedCampusId as number) ? undefined : parsedCampusId,
    );
    return createApiResponse(data, HttpStatus.OK, 'Segments retrieved successfully');
  }

  @Get('campus-map')
  @CheckPolicies(
    (ability) => ability.can(Action.Read, 'Employee') || ability.can(Action.Read, 'Class'),
  )
  async listCampusSegments() {
    const data = await this.segmentsService.listCampusSegments();
    return createApiResponse(data, HttpStatus.OK, 'Campus segment map retrieved successfully');
  }

  @Put('campus-map/:campusId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('school-setup.segments#edit')
  async setCampusSegments(
    @Param('campusId', ParseIntPipe) campusId: number,
    @Body() dto: SetCampusSegmentsDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.segmentsService.setCampusSegments(campusId, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Campus segments updated successfully');
  }

  @Get('classes-available')
  @CheckPolicies(
    (ability) => ability.can(Action.Read, 'Employee') || ability.can(Action.Read, 'Class'),
  )
  async listAvailableClasses() {
    const data = await this.segmentsService.listAvailableClasses();
    return createApiResponse(data, HttpStatus.OK, 'Available classes retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('school-setup.segments#create')
  async create(@Body() dto: CreateSegmentDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.segmentsService.create(dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Segment created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('school-setup.segments#edit')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSegmentDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.segmentsService.update(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Segment updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('school-setup.segments#delete')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.segmentsService.remove(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Segment deleted successfully');
  }
}
