import {
  Controller,
  Get,
  Post,
  Patch,
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
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';

@ApiTags('HR Segments')
@ApiBearerAuth()
@Controller('hr/segments')
@UseGuards(JwtStaffGuard, PoliciesGuard)
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
  async create(@Body() dto: CreateSegmentDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.segmentsService.create(dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Segment created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
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
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.segmentsService.remove(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Segment deleted successfully');
  }
}
