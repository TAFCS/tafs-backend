import { Controller, Get, Post, Body, Param, ParseIntPipe, HttpStatus, Query } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { EnrollStudentDto } from './dto/enroll-student.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { createApiResponse } from '../../utils/serializer.util';

@ApiTags('enrollments')
@Controller('enrollments')
export class EnrollmentController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

  @Get('candidates')
  @ApiOperation({ summary: 'Get list of students with SOFT_ADMISSION status' })
  async getCandidates() {
    const candidates = await this.enrollmentService.getCandidates();
    return createApiResponse(
      candidates,
      HttpStatus.OK,
      'Enrollment candidates retrieved successfully'
    );
  }

  @Get(':cc/suggestions')
  @ApiOperation({ summary: 'Get suggested GR number and balanced House for a student' })
  async getSuggestions(
    @Param('cc', ParseIntPipe) cc: number,
    @Query('section_id') sectionId?: number,
  ) {
    const suggestions = await this.enrollmentService.getSuggestions(cc, sectionId);
    return createApiResponse(
      suggestions,
      HttpStatus.OK,
      'Enrollment suggestions retrieved successfully'
    );
  }

  @Post(':cc/enroll')
  @ApiOperation({ summary: 'Formally enroll a student with final GR and House' })
  async enroll(
    @Param('cc', ParseIntPipe) cc: number,
    @Body() dto: EnrollStudentDto,
  ) {
    const student = await this.enrollmentService.enroll(cc, dto);
    return createApiResponse(
      student,
      HttpStatus.OK,
      'Student enrolled successfully'
    );
  }

  @Get(':cc/admission-order')
  @ApiOperation({ summary: 'Get student data for admission order PDF' })
  async getAdmissionOrder(@Param('cc', ParseIntPipe) cc: number) {
    const data = await this.enrollmentService.getAdmissionOrderData(cc);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Admission order data retrieved successfully'
    );
  }
}
