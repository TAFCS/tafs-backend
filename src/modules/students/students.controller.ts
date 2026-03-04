import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StudentsService } from './students.service';
import { GetStudentsDto } from './dto/get-students.dto';
import { createPaginatedApiResponse } from '../../utils/serializer.util';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';

@Controller('students')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async findAll(@Query() query: GetStudentsDto) {
    const { items, meta } = await this.studentsService.findAll(query);
    return createPaginatedApiResponse(
      items,
      meta,
      200,
      'Students list retrieved successfully',
    );
  }
}
