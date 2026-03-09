import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { StudentsService } from './students.service';
import { GetStudentsDto } from './dto/get-students.dto';
import { AssignStudentDto } from './dto/assign-student.dto';
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

  @Get('search-simple')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async searchSimple(@Query('q') q: string) {
    const results = await this.studentsService.searchSimple(q || '');
    return createApiResponse(
      results,
      HttpStatus.OK,
      'Search results retrieved successfully',
    );
  }

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

  @Patch(':id/assignment')
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  async assignStudent(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignStudentDto,
  ) {
    const updated = await this.studentsService.assignStudent(id, dto);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      'Student assignment updated successfully',
    );
  }
}
