import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { EnrollStudentDto } from './dto/enroll-student.dto';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { createApiResponse } from '../../utils/serializer.util';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@ApiTags('enrollments')
@ApiBearerAuth()
@Controller('enrollments')
@UseGuards(JwtStaffGuard)
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

  @Get('houses')
  @ApiOperation({ summary: 'Get list of all houses' })
  async getHouses() {
    const houses = await this.enrollmentService.getAllHouses();
    return createApiResponse(
      houses,
      HttpStatus.OK,
      'Houses retrieved successfully'
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
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const student = await this.enrollmentService.enroll(cc, dto, user.username);
    return createApiResponse(
      student,
      HttpStatus.OK,
      'Student enrolled successfully'
    );
  }

  @Patch(':cc/pursuit-status')
  @ApiOperation({ summary: 'Update whether a candidate is not pursuing admission' })
  async updatePursuitStatus(
    @Param('cc', ParseIntPipe) cc: number,
    @Body('not_pursuing') notPursuing: boolean,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const student = await this.enrollmentService.updatePursuitStatus(cc, notPursuing, user.username);
    return createApiResponse(
      student,
      HttpStatus.OK,
      'Student pursuit status updated successfully'
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

  @Get(':cc/leaving-certificate')
  @ApiOperation({ summary: 'Get student data for leaving certificate (SLC) PDF' })
  async getLeavingCertificate(@Param('cc', ParseIntPipe) cc: number) {
    const data = await this.enrollmentService.getLeavingCertificateData(cc);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Leaving certificate data retrieved successfully'
    );
  }
}
