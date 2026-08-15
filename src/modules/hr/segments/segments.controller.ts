import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import { SegmentsService } from './segments.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';

@ApiTags('HR Segments')
@ApiBearerAuth()
@Controller('hr/segments')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class SegmentsController {
  constructor(private readonly segmentsService: SegmentsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async findAll() {
    const data = await this.segmentsService.findAll();
    return createApiResponse(data, HttpStatus.OK, 'Segments retrieved successfully');
  }
}
