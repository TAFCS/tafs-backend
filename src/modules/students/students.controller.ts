import { Controller, Get, HttpStatus, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { StudentsService } from './students.service';
import { GetStudentsDto } from './dto/get-students.dto';
import { createApiResponse, createPaginatedApiResponse } from '../../utils/serializer.util';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { STUDENTS_MESSAGES } from '../../constants/api-response/students.constant';

@Controller('students')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) { }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async findAll(@Query() query: GetStudentsDto) {
    const { items, meta } = await this.studentsService.findAll(query);
    return createPaginatedApiResponse(
      items,
      meta,
      HttpStatus.OK,
      STUDENTS_MESSAGES.LIST_SUCCESS,
    );
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const student = await this.studentsService.findOne(id);
    return createApiResponse(
      student,
      HttpStatus.OK,
      STUDENTS_MESSAGES.RETRIEVE_SUCCESS,
    );
  }
}
